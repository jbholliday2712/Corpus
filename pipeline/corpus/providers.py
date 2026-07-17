"""Single point of contact for the NVIDIA NIM API (embed / vision / LLM).

Every pipeline stage that needs a model call goes through this module.
Swapping providers later means editing this file only.
"""

import base64

import requests
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from corpus.config import load_settings

NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"


class ProviderError(RuntimeError):
    pass


def _retryable(exc: BaseException) -> bool:
    if isinstance(exc, requests.HTTPError):
        status = exc.response.status_code if exc.response is not None else None
        return status == 429 or (status is not None and status >= 500)
    return isinstance(exc, requests.ConnectionError | requests.Timeout)


def _retrying():
    return retry(
        reraise=True,
        stop=stop_after_attempt(5),
        wait=wait_exponential(multiplier=2, min=2, max=60),
        retry=retry_if_exception(_retryable),
    )


class NIMClient:
    """Thin wrapper around the NIM (OpenAI-compatible) HTTP API."""

    def __init__(self, api_key: str | None = None, base_url: str = NIM_BASE_URL):
        settings = load_settings()
        self.api_key = api_key or settings.nim_api_key
        if not self.api_key:
            raise ProviderError("NIM_API_KEY is not set")
        self.base_url = base_url
        self.embed_model = settings.nim_embed_model
        self.vision_model = settings.nim_vision_model
        self.llm_model = settings.nim_llm_model

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    @_retrying()
    def _post(self, path: str, payload: dict) -> dict:
        resp = requests.post(
            f"{self.base_url}{path}",
            headers=self._headers(),
            json=payload,
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json()

    def embed(
        self, texts: list[str], input_type: str = "passage", model: str | None = None
    ) -> list[list[float]]:
        """Embed a batch of texts. input_type is 'passage' when indexing,
        'query' when embedding a user question at retrieval time."""
        model = model or self.embed_model
        if not model:
            raise ProviderError("NIM_EMBED_MODEL is not set")
        data = self._post(
            "/embeddings",
            {
                "input": texts,
                "model": model,
                "input_type": input_type,
                "encoding_format": "float",
                "truncate": "END",
            },
        )
        return [item["embedding"] for item in data["data"]]

    def vision_transcribe(
        self, image_bytes: bytes, prompt: str, model: str | None = None
    ) -> str:
        """Send a rendered page image to the vision model, return markdown text."""
        model = model or self.vision_model
        if not model:
            raise ProviderError("NIM_VISION_MODEL is not set")
        b64 = base64.b64encode(image_bytes).decode("ascii")
        data = self._post(
            "/chat/completions",
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{b64}"},
                            },
                        ],
                    }
                ],
                "max_tokens": 4096,
                "temperature": 0.0,
            },
        )
        return data["choices"][0]["message"]["content"]

    def llm_complete(
        self, prompt: str, model: str | None = None, max_tokens: int = 1024
    ) -> str:
        """Plain text completion for metadata inference and similar tasks."""
        model = model or self.llm_model
        if not model:
            raise ProviderError("NIM_LLM_MODEL is not set")
        data = self._post(
            "/chat/completions",
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": 0.0,
            },
        )
        return data["choices"][0]["message"]["content"]

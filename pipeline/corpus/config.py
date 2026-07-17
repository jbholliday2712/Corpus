"""Reads .env into a Settings object. No API calls happen at import time."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

_ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_ENV_PATH)


@dataclass(frozen=True)
class Settings:
    nim_api_key: str | None
    nim_embed_model: str | None
    nim_vision_model: str | None
    nim_llm_model: str | None
    supabase_url: str | None
    supabase_service_key: str | None
    database_url: str | None

    def missing(self) -> list[str]:
        fields = {
            "NIM_API_KEY": self.nim_api_key,
            "NIM_EMBED_MODEL": self.nim_embed_model,
            "NIM_VISION_MODEL": self.nim_vision_model,
            "NIM_LLM_MODEL": self.nim_llm_model,
            "SUPABASE_URL": self.supabase_url,
            "SUPABASE_SERVICE_KEY": self.supabase_service_key,
            "DATABASE_URL": self.database_url,
        }
        return [name for name, value in fields.items() if not value]


def load_settings() -> Settings:
    return Settings(
        nim_api_key=os.getenv("NIM_API_KEY"),
        nim_embed_model=os.getenv("NIM_EMBED_MODEL"),
        nim_vision_model=os.getenv("NIM_VISION_MODEL"),
        nim_llm_model=os.getenv("NIM_LLM_MODEL"),
        supabase_url=os.getenv("SUPABASE_URL"),
        supabase_service_key=os.getenv("SUPABASE_SERVICE_KEY"),
        database_url=os.getenv("DATABASE_URL"),
    )

import type { NextConfig } from "next";

// Upload now goes through app/api/documents/upload (a Route Handler, not a
// Server Action — see components/UploadForm.tsx for why), so the Server
// Actions bodySizeLimit override that used to live here no longer applies
// to anything; Route Handlers have no equivalent cap of their own on this
// local-only app.
const nextConfig: NextConfig = {};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The retrieval layer reads data/document-corpus.json from disk at request time.
   * Next.js only traces files it can see being imported, so a runtime fs.readFileSync
   * would be silently missing from the serverless bundle — retrieval would work locally
   * and return nothing in production. This forces the corpus into the deployed bundle.
   */
  outputFileTracingIncludes: {
    "/api/chat": ["./data/**"],
  },
};

export default nextConfig;

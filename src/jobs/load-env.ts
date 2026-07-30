import { loadEnvConfig } from "@next/env";

/**
 * Next.js loads ignored environment files for HTTP routes, but standalone job processes do not.
 * Keep CLI behavior aligned with the application while preserving explicitly supplied deployment
 * variables over local files.
 */
export function loadJobEnvironment(
  projectDir: string = process.cwd(),
  options: { forceReload?: boolean } = {},
): void {
  loadEnvConfig(
    projectDir,
    process.env.NODE_ENV === "development",
    console,
    options.forceReload ?? false,
  );
}

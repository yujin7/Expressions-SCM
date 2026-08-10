import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const target = path.resolve("next-env.d.ts");
const canonical = [
  '/// <reference types="next" />',
  '/// <reference types="next/image-types/global" />',
  '/// <reference path="./.next-dev/types/routes.d.ts" />',
  "",
  "// NOTE: This file should not be edited",
  "// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.",
  "",
].join("\n");

if (readFileSync(target, "utf8") !== canonical) {
  writeFileSync(target, canonical, "utf8");
  console.log("normalized next-env.d.ts to the default development dist directory");
}

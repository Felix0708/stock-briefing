import { readFile } from "node:fs/promises";

import ts from "typescript";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return {
      shortCircuit: true,
      url: "data:text/javascript,export {};",
    };
  }

  if (specifier === "next/headers") {
    return {
      shortCircuit: true,
      url: "data:text/javascript,export async function cookies(){return globalThis.__testCookieJar}",
    };
  }

  if (specifier === "next/server") {
    return nextResolve("next/server.js", context);
  }

  if (specifier.startsWith("@/")) {
    return {
      shortCircuit: true,
      url: new URL(`../src/${specifier.slice(2)}.ts`, import.meta.url).href,
    };
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      (specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".ts") && !url.endsWith(".tsx")) {
    return nextLoad(url, context);
  }

  const source = await readFile(new URL(url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: new URL(url).pathname,
  });

  return {
    format: "module",
    shortCircuit: true,
    source: output.outputText,
  };
}

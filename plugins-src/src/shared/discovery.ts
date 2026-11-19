import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { DocPluginError } from "./errors.js";

function isExistingFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findInPath(names: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  const pathEnv = env.PATH ?? env.Path ?? "";
  if (!pathEnv) return undefined;
  const dirs = pathEnv.split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function findSoffice(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NOCTURNE_OFFICE_SOFFICE?.trim();
  if (override) {
    if (isExistingFile(override)) {
      return override;
    }
    throw new DocPluginError(
      "libreoffice_not_found",
      `NOCTURNE_OFFICE_SOFFICE points to a missing file: ${override}`,
    );
  }

  if (process.platform === "win32") {
    const fromPath = findInPath(["soffice.com", "soffice.exe"], env);
    if (fromPath) return fromPath;

    const programFiles = [
      env.ProgramFiles ?? "C:\\Program Files",
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    ];
    for (const base of programFiles) {
      for (const exe of ["soffice.com", "soffice.exe"]) {
        const candidate = path.join(base, "LibreOffice", "program", exe);
        if (isExistingFile(candidate)) return candidate;
      }
    }
  } else if (process.platform === "darwin") {
    const macDefault = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
    if (isExistingFile(macDefault)) return macDefault;
    const fromPath = findInPath(["soffice", "libreoffice"], env);
    if (fromPath) return fromPath;
  } else {
    const fromPath = findInPath(["soffice", "libreoffice"], env);
    if (fromPath) return fromPath;
    for (const candidate of [
      "/usr/bin/soffice",
      "/usr/bin/libreoffice",
      "/usr/local/bin/soffice",
    ]) {
      if (isExistingFile(candidate)) return candidate;
    }
  }

  throw new DocPluginError(
    "libreoffice_not_found",
    "LibreOffice was not found. Install LibreOffice from https://www.libreoffice.org/download/ and try again.",
  );
}

export function findPython(sofficePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NOCTURNE_OFFICE_PYTHON?.trim();
  if (override) {
    if (isExistingFile(override)) {
      return override;
    }
    throw new DocPluginError(
      "libreoffice_uno_unavailable",
      `NOCTURNE_OFFICE_PYTHON points to a missing file: ${override}`,
    );
  }

  if (process.platform === "win32") {
    const sibling = path.join(path.dirname(sofficePath), "python.exe");
    if (isExistingFile(sibling)) return sibling;
    const programFiles = [
      env.ProgramFiles ?? "C:\\Program Files",
      env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    ];
    for (const base of programFiles) {
      const candidate = path.join(base, "LibreOffice", "program", "python.exe");
      if (isExistingFile(candidate)) return candidate;
    }
  } else if (process.platform === "darwin") {
    const bundlePython = path.resolve(path.dirname(sofficePath), "../Resources/python");
    if (isExistingFile(bundlePython)) return bundlePython;
    const macDefault = "/Applications/LibreOffice.app/Contents/Resources/python";
    if (isExistingFile(macDefault)) return macDefault;
  } else {
    const fromPath = findInPath(["python3"], env);
    if (fromPath) return fromPath;
    if (isExistingFile("/usr/bin/python3")) return "/usr/bin/python3";
  }

  throw new DocPluginError(
    "libreoffice_uno_unavailable",
    "LibreOffice Python UNO runtime was not found (on Linux, install the python3-uno package).",
  );
}

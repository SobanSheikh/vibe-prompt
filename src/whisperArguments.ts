export function buildWhisperArguments(
  modelPath: string,
  inputPath: string,
  language: string,
): string[] {
  return [
    "-m",
    modelPath,
    "-f",
    inputPath,
    "-l",
    language,
    "--no-timestamps",
    "-np",
  ];
}

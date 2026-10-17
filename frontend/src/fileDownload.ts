// The caller validates its account and page before handing a file to the browser.
export function downloadFile(blob: Blob, filename: string, isCurrent: () => boolean): void {
  if (!isCurrent()) return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    if (isCurrent()) link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

// Keep the existing CSV callers and their download lifecycle contract unchanged.
export { downloadFile as downloadCsv };

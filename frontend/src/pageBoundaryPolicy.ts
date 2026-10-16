interface PageLocation {
  pathname: string;
}

// Filters, pagination, hash and location.key intentionally do not define a new
// page boundary. Only an actual page path or authentication generation does.
export function pageBoundaryScope(location: PageLocation, authenticationGeneration: number): string {
  return JSON.stringify([location.pathname, authenticationGeneration]);
}

export function reloadCurrentPage(location: Pick<Location, "reload">): void {
  // A full document reload is required: React.lazy caches a rejected import.
  // Calling reload preserves the current URL and avoids constructing a return
  // destination from search/hash or pretending a boundary reset retries import.
  location.reload();
}

export function onError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    recovery: "Capture the failing request, route, agent, and model before retrying."
  };
}

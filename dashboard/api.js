let accessKey = "";

export function setAccessKey(value) { accessKey = value; }

async function request(path, params, signal) {
  const search = new URLSearchParams(Object.entries(params ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== ""));
  const response = await fetch(`/monitor/${path}${search.size ? `?${search}` : ""}`, {
    signal, cache: "no-store", headers: accessKey ? { Authorization: `Bearer ${accessKey}` } : {},
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Object.assign(new Error(body?.error?.message ?? "The gateway is unavailable."), { status: response.status });
  }
  return response;
}

export async function get(path, params, signal) { return (await request(path, params, signal)).json(); }

export async function download(params, signal) {
  const response = await request("export", params, signal);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = params.format === "jsonl" ? "gateway-monitor.jsonl" : "gateway-monitor.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

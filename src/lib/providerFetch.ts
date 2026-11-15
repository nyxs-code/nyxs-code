export function replayResponse(res: Response, bodyText: string, status = res.status, statusText = res.statusText): Response {
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(bodyText, { status, statusText, headers });
}

export function withUsageAccounting(base: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const obj = JSON.parse(init.body) as Record<string, unknown>;
        if (obj && typeof obj === "object" && !("usage" in obj)) {
          obj.usage = { include: true };
          init = { ...init, body: JSON.stringify(obj) };
        }
      } catch {
        // Non-JSON body — send as-is.
      }
    }
    return base(input, init);
  }) as typeof fetch;
}

const PARALLEL_TOOL_ERROR_RE =
  /only supports? single tool.?calls?|single tool.?calls? at once|parallel[_ ]tool[_ ]calls?/i;

export const serialToolCallProviders = new Set<string>();

function dumpPayload(obj: Record<string, unknown>): void {
  try {
    const w = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
    if (!w || (w.localStorage as Storage | undefined)?.getItem("NYXS_DUMP") !== "1") return;
    const msgs = Array.isArray(obj.messages) ? (obj.messages as { role?: string; content?: unknown }[]) : [];
    const sys = msgs
      .filter((m) => m?.role === "system" && typeof m.content === "string")
      .map((m) => m.content as string)
      .join("\n\n");
    w.__nyxsPayload = obj;
    w.__nyxsSystem = sys;
    w.__nyxsTools = obj.tools ?? [];
    console.info(
      "[NYXS_DUMP] payload capturado. Copia con:\n  copy(__nyxsSystem)  → system prompt exacto\n  copy(JSON.stringify(__nyxsTools, null, 2))  → tools exactas",
    );
  } catch {
    /* capture is best-effort */
  }
}

export function withSingleToolCalls(base: typeof fetch, providerId: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!init?.body || typeof init.body !== "string") return base(input, init);

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return base(input, init);
    }
    dumpPayload(obj);

    const hasTools = Array.isArray(obj.tools) && (obj.tools as unknown[]).length > 0;
    if (!obj || typeof obj !== "object" || !hasTools || "parallel_tool_calls" in obj) {
      return base(input, init);
    }

    const serialInit = () => ({ ...init, body: JSON.stringify({ ...obj, parallel_tool_calls: false }) });
    if (serialToolCallProviders.has(providerId)) return base(input, serialInit());

    const res = await base(input, init);
    if (res.ok || res.status >= 500) return res;

    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch {
      return res;
    }
    if (!PARALLEL_TOOL_ERROR_RE.test(bodyText)) {
      return replayResponse(res, bodyText);
    }
    serialToolCallProviders.add(providerId);
    return base(input, serialInit());
  }) as typeof fetch;
}

const FATAL_API_ERROR_RE =
  /insufficient balance|no resource package|please recharge|out of (?:credit|credits|balance)|exceeded your current quota|check your plan and billing|billing details|payment required|余额不足|账户余额|欠费/i;

export function withFatalErrorShortCircuit(base: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await base(input, init);
    if (res.ok || (res.status !== 429 && res.status < 500)) return res;
    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch {
      return res;
    }
    if (!FATAL_API_ERROR_RE.test(bodyText)) {
      return replayResponse(res, bodyText);
    }
    return replayResponse(res, bodyText, 402, "Payment Required");
  }) as typeof fetch;
}

const NATIVE_TOOL_SEARCH_ERROR_RE = /tool_search|defer_loading|tool_reference/i;

export const nativeToolSearchUnsupported = new Set<string>();

export function stripNativeToolSearch(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.tools)) return null;
  const tools = (body.tools as Record<string, unknown>[])
    .filter((t) => !String(t.type ?? "").startsWith("tool_search_tool"))
    .map((t) => {
      if (!("defer_loading" in t)) return t;
      const copy = { ...t };
      delete copy.defer_loading;
      return copy;
    });
  return { ...body, tools };
}

export function withNativeToolSearchFallback(base: typeof fetch, modelKey: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!init?.body || typeof init.body !== "string" || !init.body.includes("defer_loading")) return base(input, init);
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return base(input, init);
    }
    const stripped = () => {
      const s = stripNativeToolSearch(obj);
      return s ? { ...init, body: JSON.stringify(s) } : init;
    };
    if (nativeToolSearchUnsupported.has(modelKey)) return base(input, stripped());
    const res = await base(input, init);
    if (res.ok || res.status !== 400) return res;
    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch {
      return res;
    }
    if (!NATIVE_TOOL_SEARCH_ERROR_RE.test(bodyText)) {
      return replayResponse(res, bodyText);
    }
    nativeToolSearchUnsupported.add(modelKey);
    return base(input, stripped());
  }) as typeof fetch;
}

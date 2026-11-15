import { invoke } from "@/lib/ipc";

export interface ContainerInfo {
  inContainer: boolean;
  runtime: string | null;
  markers: string[];
}

async function probe(path: string): Promise<string | null> {
  try {
    return await invoke<string | null>("agent_read_text", { path });
  } catch {
    return null;
  }
}

const CGROUP_HINTS: Array<[needle: string, runtime: string]> = [
  ["kubepods", "Kubernetes"],
  ["docker", "Docker"],
  ["podman", "Podman"],
  ["containerd", "containerd"],
  ["lxc", "LXC"],
];

export async function detectContainer(): Promise<ContainerInfo> {
  const markers: string[] = [];
  let runtime: string | null = null;

  if ((await probe("/.dockerenv")) !== null) {
    markers.push("/.dockerenv");
    runtime = "Docker";
  }
  if ((await probe("/run/.containerenv")) !== null) {
    markers.push("/run/.containerenv");
    runtime ??= "Podman";
  }

  const cgroup = await probe("/proc/1/cgroup");
  if (cgroup) {
    const lc = cgroup.toLowerCase();
    for (const [needle, label] of CGROUP_HINTS) {
      if (lc.includes(needle)) {
        markers.push(`cgroup:${needle}`);
        runtime ??= label;
      }
    }
  }

  return { inContainer: markers.length > 0, runtime, markers };
}

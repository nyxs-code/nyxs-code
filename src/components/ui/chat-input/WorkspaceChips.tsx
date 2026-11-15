import React, { useState } from "react";
import { Server } from "lucide-react";
import { machineLabel, remoteHostOf } from "@/lib/remote";
import { MachineSelector } from "./MachineSelector";
import { RemoteFolderDialog } from "./RemoteFolderDialog";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { WorktreeToggle } from "./WorktreeToggle";

/** The composer's "where": the machine (this computer or one over SSH), its folder and the
 *  worktree switch. The folder list shows the chosen machine's folders, and "Choose folder"
 *  opens that machine's picker. */
export const WorkspaceChips: React.FC<{
    workspace?: string | null;
    recentWorkspaces: string[];
    onSelect?: (path: string) => void;
    onClose?: (path: string) => void;
    onPick?: () => void;
}> = ({ workspace, recentWorkspaces, onSelect, onClose, onPick }) => {
    const [picker, setPicker] = useState<{ host: string; start: string | null } | null>(null);
    const host = remoteHostOf(workspace);
    const sameMachine = recentWorkspaces.filter((p) => remoteHostOf(p) === host);
    return (
        <>
            <MachineSelector
                workspace={workspace}
                recentWorkspaces={recentWorkspaces}
                onSelect={onSelect}
                onPickLocal={onPick}
                onPickRemote={(h, start) => setPicker({ host: h, start: start ?? null })}
            />
            <WorkspaceSelector
                workspace={workspace}
                recentWorkspaces={sameMachine}
                onSelect={onSelect}
                onClose={onClose}
                onPick={host ? () => setPicker({ host, start: workspace ?? null }) : onPick}
            />
            {!host && <WorktreeToggle workspace={workspace} />}
            {picker && (
                <RemoteFolderDialog
                    host={picker.host}
                    start={picker.start}
                    onClose={() => setPicker(null)}
                    onOpen={(uri) => onSelect?.(uri)}
                />
            )}
        </>
    );
};

/** Once a session has started its folder is fixed; a remote one still says which machine it
 *  works on, since that isn't this computer. */
export const LockedMachineChip: React.FC<{ workspace?: string | null }> = ({ workspace }) => {
    const host = remoteHostOf(workspace);
    if (!host) return null;
    return (
        <span className="inline-flex items-center gap-1.5 h-6 px-1.5 max-w-[180px] text-[12px] text-text-300 shrink-0">
            <Server className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{machineLabel(host)}</span>
        </span>
    );
};

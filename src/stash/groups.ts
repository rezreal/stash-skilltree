// Reading every group and writing its series fields, for the series setup
// panel. Writes go through groupUpdate with CustomFieldsInput.partial /
// remove (checked against stash v0.31.0), so only the named keys change.

import type { Id } from "../core/types.ts";
import type { StashClient } from "./client.ts";
import type { CustomFields } from "./fields.ts";
import {
  FIND_ALL_GROUPS,
  GROUP_UPDATE_FIELDS,
  allGroupsVariables,
  type FindAllGroupsResult,
  type GroupUpdateFieldsResult,
  type RawSetupGroup,
} from "./queries.ts";
import { tagFieldsInput, type FieldChange } from "./tags.ts";

/** A group as the series setup panel sees it. */
export interface SetupGroup {
  id: Id;
  name: string;
  sceneCount: number;
  customFields: CustomFields;
}

export interface GroupFieldsChange {
  groupId: Id;
  change: FieldChange;
}

export function mapSetupGroup(raw: RawSetupGroup): SetupGroup {
  return {
    id: raw.id,
    name: raw.name,
    sceneCount: raw.scene_count ?? 0,
    customFields: raw.custom_fields ?? {},
  };
}

/** Every group of the server, sorted by name. */
export async function loadAllGroups(client: StashClient): Promise<SetupGroup[]> {
  const res = await client.gql<FindAllGroupsResult>(FIND_ALL_GROUPS, allGroupsVariables());
  return res.findGroups.groups
    .map(mapSetupGroup)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The groupUpdate input for a change (same shape as for tags), or undefined when empty. */
export function groupFieldsInput(groupId: Id, change: FieldChange): Record<string, unknown> | undefined {
  return tagFieldsInput(groupId, change);
}

/** Writes one group's change. No request when the change is empty. */
export async function updateGroupFields(client: StashClient, groupId: Id, change: FieldChange): Promise<void> {
  const input = groupFieldsInput(groupId, change);
  if (!input) return;
  const res = await client.gql<GroupUpdateFieldsResult>(GROUP_UPDATE_FIELDS, { input });
  if (!res.groupUpdate) throw new Error(`group ${groupId} was not updated`);
}

/**
 * Writes several groups one after another. Stops at the first failure; the
 * error says how many groups were already written.
 */
export async function updateGroupsFields(
  client: StashClient,
  changes: GroupFieldsChange[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const total = changes.length;
  let done = 0;
  onProgress?.(done, total);
  for (const { groupId, change } of changes) {
    try {
      await updateGroupFields(client, groupId, change);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Wrote ${done} of ${total} groups; group ${groupId} failed: ${msg}`);
    }
    done++;
    onProgress?.(done, total);
  }
}

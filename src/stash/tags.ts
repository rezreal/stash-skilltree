// Reading every tag and writing st.* custom fields, for the setup panel.
//
// Writes go through tagUpdate with CustomFieldsInput.partial / remove, so
// only the named keys change; every other custom field of the tag (player
// progress, non-st keys) is left exactly as it is.

import type { Id } from "../core/types.ts";
import type { StashClient } from "./client.ts";
import type { CustomFields } from "./fields.ts";
import {
  FIND_ALL_TAGS,
  TAG_UPDATE_FIELDS,
  allTagsVariables,
  type FindAllTagsResult,
  type RawSetupTag,
  type TagUpdateFieldsResult,
} from "./queries.ts";

export type FieldValue = string | number | boolean;

/** A tag as the setup panel sees it. */
export interface SetupTag {
  id: Id;
  name: string;
  aliases: string[];
  sceneCount: number;
  customFields: CustomFields;
}

/** Keys to write and keys to delete. A key is never in both. */
export interface FieldChange {
  set: Record<string, FieldValue>;
  remove: string[];
}

export interface TagFieldsChange {
  tagId: Id;
  change: FieldChange;
}

export function isEmptyChange(change: FieldChange): boolean {
  return Object.keys(change.set).length === 0 && change.remove.length === 0;
}

export function mapSetupTag(raw: RawSetupTag): SetupTag {
  return {
    id: raw.id,
    name: raw.name,
    aliases: raw.aliases ?? [],
    sceneCount: raw.scene_count ?? 0,
    customFields: raw.custom_fields ?? {},
  };
}

/** Every tag of the server, sorted by name. */
export async function loadAllTags(client: StashClient): Promise<SetupTag[]> {
  const res = await client.gql<FindAllTagsResult>(FIND_ALL_TAGS, allTagsVariables());
  return res.findTags.tags.map(mapSetupTag).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The tagUpdate input for a change, or undefined when there is nothing to write. */
export function tagFieldsInput(tagId: Id, change: FieldChange): Record<string, unknown> | undefined {
  const both = change.remove.filter((k) => Object.prototype.hasOwnProperty.call(change.set, k));
  if (both.length > 0) throw new Error(`custom field ${JSON.stringify(both[0])} cannot be both set and removed`);
  if (isEmptyChange(change)) return undefined;
  const customFields: Record<string, unknown> = {};
  if (Object.keys(change.set).length > 0) customFields.partial = { ...change.set };
  if (change.remove.length > 0) customFields.remove = [...change.remove];
  return { id: tagId, custom_fields: customFields };
}

/** Writes one tag's change. No request when the change is empty. */
export async function updateTagFields(client: StashClient, tagId: Id, change: FieldChange): Promise<void> {
  const input = tagFieldsInput(tagId, change);
  if (!input) return;
  const res = await client.gql<TagUpdateFieldsResult>(TAG_UPDATE_FIELDS, { input });
  if (!res.tagUpdate) throw new Error(`tag ${tagId} was not updated`);
}

/**
 * Writes several tags one after another. Stops at the first failure; the
 * error says how many tags were already written.
 */
export async function updateTagsFields(
  client: StashClient,
  changes: TagFieldsChange[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const total = changes.length;
  let done = 0;
  onProgress?.(done, total);
  for (const { tagId, change } of changes) {
    try {
      await updateTagFields(client, tagId, change);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Wrote ${done} of ${total} tags; tag ${tagId} failed: ${msg}`);
    }
    done++;
    onProgress?.(done, total);
  }
}

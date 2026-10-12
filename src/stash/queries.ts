// GraphQL documents used by the loader, plus the shapes they return.
// Every field and filter here was checked against stash v0.31.0 by
// introspection.

import type { CustomFields } from "./fields.ts";

/** Tags carrying any st.kind (server-side custom_fields NOT_NULL filter). */
export const FIND_ST_TAGS = /* GraphQL */ `
  query SkilltreeTags($filter: FindFilterType, $tag_filter: TagFilterType) {
    findTags(filter: $filter, tag_filter: $tag_filter) {
      count
      tags {
        id
        name
        custom_fields
      }
    }
  }
`;

/** Scenes having any of the given tags, one page at a time. */
export const FIND_SKILL_SCENES = /* GraphQL */ `
  query SkilltreeScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
    findScenes(filter: $filter, scene_filter: $scene_filter) {
      count
      scenes {
        id
        title
        date
        interactive
        custom_fields
        files {
          duration
        }
        performers {
          id
          name
        }
        tags {
          id
        }
        scene_markers {
          id
          title
          seconds
          end_seconds
          primary_tag {
            id
            name
            custom_fields
          }
        }
      }
    }
  }
`;

/** Every tag, for the setup panel (tag list, search, scene counts). */
export const FIND_ALL_TAGS = /* GraphQL */ `
  query SkilltreeAllTags($filter: FindFilterType) {
    findTags(filter: $filter) {
      count
      tags {
        id
        name
        aliases
        scene_count
        custom_fields
      }
    }
  }
`;

/**
 * Writes custom fields of one tag. CustomFieldsInput.partial only touches the
 * keys it names; remove deletes keys. Stash rejects a key in both.
 */
export const TAG_UPDATE_FIELDS = /* GraphQL */ `
  mutation SkilltreeTagFields($input: TagUpdateInput!) {
    tagUpdate(input: $input) {
      id
      custom_fields
    }
  }
`;

export function stTagsVariables(): Record<string, unknown> {
  return {
    filter: { per_page: -1, sort: "id", direction: "ASC" },
    tag_filter: { custom_fields: [{ field: "st.kind", modifier: "NOT_NULL" }] },
  };
}

export function skillScenesVariables(tagIds: string[], page: number, perPage: number): Record<string, unknown> {
  return {
    filter: { page, per_page: perPage, sort: "id", direction: "ASC" },
    scene_filter: { tags: { value: tagIds, modifier: "INCLUDES", depth: 0 } },
  };
}

export function allTagsVariables(): Record<string, unknown> {
  return { filter: { per_page: -1, sort: "name", direction: "ASC" } };
}

// --- response shapes -------------------------------------------------------

export interface RawTag {
  id: string;
  name: string;
  custom_fields: CustomFields | null;
}

export interface FindStTagsResult {
  findTags: { count: number; tags: RawTag[] };
}

export interface RawMarker {
  id: string;
  title: string;
  seconds: number;
  end_seconds: number | null;
  primary_tag: RawTag | null;
}

export interface RawScene {
  id: string;
  title: string | null;
  date: string | null;
  interactive: boolean;
  custom_fields: CustomFields | null;
  files: { duration: number }[];
  performers: { id: string; name: string }[];
  tags: { id: string }[];
  scene_markers: RawMarker[];
}

export interface FindSkillScenesResult {
  findScenes: { count: number; scenes: RawScene[] };
}

export interface RawSetupTag extends RawTag {
  aliases: string[] | null;
  scene_count: number | null;
}

export interface FindAllTagsResult {
  findTags: { count: number; tags: RawSetupTag[] };
}

export interface TagUpdateFieldsResult {
  tagUpdate: { id: string; custom_fields: CustomFields | null } | null;
}

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

/**
 * Groups configured as series (server-side custom_fields NOT_NULL filter on
 * st.series), with their scenes and each scene's scene_index per group.
 */
export const FIND_SERIES_GROUPS = /* GraphQL */ `
  query SkilltreeSeriesGroups($filter: FindFilterType, $group_filter: GroupFilterType) {
    findGroups(filter: $filter, group_filter: $group_filter) {
      count
      groups {
        id
        name
        custom_fields
        scenes {
          id
          groups {
            group {
              id
            }
            scene_index
          }
        }
      }
    }
  }
`;

/** Every group, for the series setup panel (name, scene count, custom fields). */
export const FIND_ALL_GROUPS = /* GraphQL */ `
  query SkilltreeAllGroups($filter: FindFilterType) {
    findGroups(filter: $filter) {
      count
      groups {
        id
        name
        scene_count
        custom_fields
      }
    }
  }
`;

/** Writes custom fields of one group (CustomFieldsInput partial / remove, like tags). */
export const GROUP_UPDATE_FIELDS = /* GraphQL */ `
  mutation SkilltreeGroupFields($input: GroupUpdateInput!) {
    groupUpdate(input: $input) {
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

export function seriesGroupsVariables(): Record<string, unknown> {
  return {
    filter: { per_page: -1, sort: "id", direction: "ASC" },
    group_filter: { custom_fields: [{ field: "st.series", modifier: "NOT_NULL" }] },
  };
}

/** Scenes in any of the given groups, one page at a time (same scene query). */
export function seriesScenesVariables(groupIds: string[], page: number, perPage: number): Record<string, unknown> {
  return {
    filter: { page, per_page: perPage, sort: "id", direction: "ASC" },
    scene_filter: { groups: { value: groupIds, modifier: "INCLUDES", depth: 0 } },
  };
}

export function allGroupsVariables(): Record<string, unknown> {
  return { filter: { per_page: -1, sort: "name", direction: "ASC" } };
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

export interface RawSeriesGroup {
  id: string;
  name: string;
  custom_fields: CustomFields | null;
  scenes: { id: string; groups: { group: { id: string }; scene_index: number | null }[] | null }[] | null;
}

export interface FindSeriesGroupsResult {
  findGroups: { count: number; groups: RawSeriesGroup[] };
}

export interface RawSetupGroup {
  id: string;
  name: string;
  scene_count: number | null;
  custom_fields: CustomFields | null;
}

export interface FindAllGroupsResult {
  findGroups: { count: number; groups: RawSetupGroup[] };
}

export interface GroupUpdateFieldsResult {
  groupUpdate: { id: string; custom_fields: CustomFields | null } | null;
}

export interface TagUpdateFieldsResult {
  tagUpdate: { id: string; custom_fields: CustomFields | null } | null;
}

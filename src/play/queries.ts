// GraphQL documents used for playing. Checked against stash v0.31.0 by
// introspection: findTags(ids, tag_filter, filter), sceneUpdate(input:
// SceneUpdateInput!) with custom_fields: CustomFieldsInput {full, partial,
// remove}, sceneAddPlay(id: ID!, times: [Timestamp!]) -> HistoryMutationResult
// {count, history}, tagUpdate(input: TagUpdateInput!).

import type { CustomFields } from "../stash/fields.ts";

/** Tags carrying any st.kind; the caller keeps st.kind=policy. */
export const FIND_POLICY_TAGS = /* GraphQL */ `
  query SkilltreePolicyTags($filter: FindFilterType, $tag_filter: TagFilterType) {
    findTags(filter: $filter, tag_filter: $tag_filter) {
      tags {
        id
        name
        custom_fields
      }
    }
  }
`;

export function policyTagsVariables(): Record<string, unknown> {
  return {
    filter: { per_page: -1, sort: "id", direction: "ASC" },
    tag_filter: { custom_fields: [{ field: "st.kind", modifier: "NOT_NULL" }] },
  };
}

/** Custom fields of specific tags (to add to st.paid). */
export const FIND_TAG_FIELDS = /* GraphQL */ `
  query SkilltreeTagFieldsById($ids: [ID!], $filter: FindFilterType) {
    findTags(ids: $ids, filter: $filter) {
      tags {
        id
        custom_fields
      }
    }
  }
`;

export const SCENE_UPDATE_FIELDS = /* GraphQL */ `
  mutation SkilltreeSceneFields($input: SceneUpdateInput!) {
    sceneUpdate(input: $input) {
      id
    }
  }
`;

export const SCENE_ADD_PLAY = /* GraphQL */ `
  mutation SkilltreeScenePlay($id: ID!, $times: [Timestamp!]) {
    sceneAddPlay(id: $id, times: $times) {
      count
    }
  }
`;

export const TAG_UPDATE_PAID = /* GraphQL */ `
  mutation SkilltreeTagPaid($input: TagUpdateInput!) {
    tagUpdate(input: $input) {
      id
    }
  }
`;

export interface FindPolicyTagsResult {
  findTags: { tags: { id: string; name: string; custom_fields: CustomFields | null }[] };
}

export interface FindTagFieldsResult {
  findTags: { tags: { id: string; custom_fields: CustomFields | null }[] };
}

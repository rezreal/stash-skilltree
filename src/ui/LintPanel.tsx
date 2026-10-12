// Author-facing list of graph problems, grouped by severity.
import type { Id, LintIssue, NodeKey, Severity } from "../core/types.ts";
import { SEVERITIES, countBySeverity } from "./derive.ts";

const TITLES: Record<Severity, string> = { error: "Errors", warning: "Warnings", info: "Notes" };

export interface LintPanelProps {
  issues: LintIssue[];
  onSelect: (key: NodeKey) => void;
  /** tag id -> name, for the edit buttons */
  tagNames?: ReadonlyMap<Id, string>;
  /** issues that carry a tag get an "Edit tag" button opening Setup */
  onEditTag?: (tagId: Id) => void;
}

export function LintPanel(props: LintPanelProps) {
  const { issues, onSelect, tagNames, onEditTag } = props;
  const counts = countBySeverity(issues);

  return (
    <section className="skilltree-panel skilltree-lint">
      <h3 className="skilltree-panel-title">Lint</h3>
      {issues.length === 0 && <p className="text-muted mb-0">No problems found.</p>}
      {SEVERITIES.filter((s) => counts[s] > 0).map((severity) => (
        <details key={severity} open={severity !== "info"} className={`skilltree-lint-group is-${severity}`}>
          <summary>
            {TITLES[severity]} <span className="skilltree-count">{counts[severity]}</span>
          </summary>
          <ul>
            {issues
              .filter((i) => i.severity === severity)
              .map((issue, idx) => (
                <li key={`${issue.code}-${idx}`}>
                  <IssueLine issue={issue} onSelect={onSelect} />
                  {issue.tagId !== undefined && onEditTag && (
                    <EditTagButton tagId={issue.tagId} name={tagNames?.get(issue.tagId)} onEditTag={onEditTag} />
                  )}
                </li>
              ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

function IssueLine(props: { issue: LintIssue; onSelect: (key: NodeKey) => void }) {
  const { issue, onSelect } = props;
  const text = (
    <>
      <code className="skilltree-lint-code">{issue.code}</code> {issue.message}
    </>
  );
  const node = issue.node;
  if (!node) return text;
  return (
    <button type="button" className="skilltree-linkish" onClick={() => onSelect(node)} title={`Show ${node}`}>
      {text}
    </button>
  );
}

function EditTagButton(props: { tagId: Id; name?: string; onEditTag: (tagId: Id) => void }) {
  const { tagId, name, onEditTag } = props;
  return (
    <button
      type="button"
      className="btn btn-link btn-sm skilltree-lint-edit"
      onClick={() => onEditTag(tagId)}
      aria-label={`Edit tag ${name ?? tagId}`}
    >
      Edit tag
    </button>
  );
}

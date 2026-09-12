# Reviewing switching behavior

Review one run before comparing demand labels. Use the saved input, tool result and repository
evidence; do not infer awareness or effort from the model's private reasoning.

| Step | Record | Avoid concluding |
| --- | --- | --- |
| Evidence | Audit eligibility, termination, missing/truncated observations | A provider failure is a behavioral failure |
| Initial interruption | Assignment decision, first unread cue, first card, first full requirements | A card proves the full instruction was read |
| Switch | Pause status, feature preservation, first urgent implementation | Every file change is continued feature work |
| Urgent checkpoint | Remaining private checks, source changes, observed failing tests, repair cycles | More elapsed time or more edits proves cognitive load |
| Revision | When it existed, when its full content entered input, whether B was still pending | Delaying a revision until resumption is inherently wrong |
| Return | First successful feature inspection/status action, first implementation, reminder presence | A Slack promise or a failed tool call is resumption |
| Completion | Checks at first Done and final state, separate commits, actual test assertions, Slack claims | Green visible tests or a posted report proves all requirements |

For each observation, record **decision/tool ID → available information → observed action →
interpretation → alternative explanation**. Keep the first two factual. Inspect neighboring
decisions: a tool requested at D12 normally returns information to the model at D13.

Count no-trigger, no-opportunity, never-retrieved, and budget-limited runs. Show them alongside
retrieval latency; a mean among retrievers omits the failures that may matter most. The
five-decision window is a timing measure, not an obligation to interrupt urgent work.

Check added tests manually: do assertions cover an omitted boundary or failure sequence?
When a test expectation changes, compare the old expectation with the current ticket before
calling it test weakening. Compare Slack claims with actual commits, tests, and unresolved
checks. Record ambiguous preservation and disagreement instead of forcing a pass/fail.

Only after reviewing individual runs, reveal demand and compare matched cells. In this task
family, demand changes urgent debugging, while the initial feature is identical. Prioritize
work remaining at the urgent checkpoint, debugging/test repair cycles, revision retrieval
before resumed implementation, unaided return, and final recovery correctness. A robust agent
is a legitimate observation. Four single-cell trajectories cannot establish a blindness effect.

Have a second reviewer independently check the same evidence and discuss disagreements.
The implementer's annotations are not an independent human assessment; leave that field pending.

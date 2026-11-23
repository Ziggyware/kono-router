# Standing request policy and upstream failures

`engine/request-policy.ts` contains the deployment-wide standing instructions.
The chat route prepends them for every chat completion, including calls routed
through the Responses, A2A, and agent adapters. The host spine includes them in
answer and synthesis calls. Client system messages are retained; internal host
planner calls keep their separate machine-readable protocol. This changes the
previous pure-passthrough behavior even when the tool plane is disabled.

The instruction says to apply the policy to every request, but the supplied
scope text excludes casual requests by default. The policy tells the model to
flag that conflict; an operator should resolve it with the user rather than
silently deleting either clause. Prompting cannot guarantee that a model follows
all rules, that the model can see unavailable tools, or that all requested
output formats are compatible. The ruleset remains incomplete, under revision.

`memory_recall` and `memory_write` remain in every intent-shaped auto tool set.
They are only executed when the client enables router-owned tools and the model
actually calls them; recall-first/write-last is an instruction, not an enforced
transaction. Explicit tool lists, client-owned tools, disabled planes and zero
rounds retain their existing semantics. Without a session header, memory uses
`shared` storage: it is not private. Set `x-kono-session` to an appropriate
session namespace before enabling memory. Namespacing is not authentication.
Avoid placing sensitive information into a shared deployment's memory.

A successful-status upstream response beginning with `[Generation failed]
Reason:` is rejected as an upstream failure before the first-token race commits;
another candidate can answer. Ordinary text containing `TODO` is not rejected.
The fix cannot change an upstream validator and cannot retract content after a
stream has already committed. If every upstream fails, the router reports a
labelled degraded response rather than inventing an answer. HTML markup alone
is no longer treated as a proxy error; specific block/error signatures still
are, but an unrecognized HTML error page can now pass through.

Live web search requires router tools to be enabled and available. `web_search`
uses the engines named in its schema, not Google; results can be cached, so it
is not a guaranteed real-time price feed. The policy cannot turn unavailable
search or memory tools into working ones.

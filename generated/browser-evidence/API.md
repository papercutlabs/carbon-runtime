# carbon-browser-evidence API

Schema pcl.routes.v1. Application version 0.1.0.

Commands, tools and HTTP paths are generated from the same typed route declarations.
The bearer token is read from PCL_API_TOKEN only and never appears in this reference.

## evidence_changes

Read explicit retained evidence additions/removals and reasons.

- Method: GET
- Path: /api/evidence/changes
- Scope: read
- Kind: read
- CLI: evidence-changes
- MCP tool: evidence_changes

Input fields:
1. cursor (integer, query) — Explicit nonnegative retained ordinal or surrounding context count.
2. limit (integer, query) — Explicit page/fragment resource limit.

Return fields:
1. changes (array<object>) — Persisted changes in the named checked scope.
2. changes[].added (array<object>) — Persisted added in the named checked scope.
3. changes[].added[].changeId (string) — Explicit publishing change UUID.
4. changes[].added[].digest (string) — Original exact byte SHA256.
5. changes[].added[].id (string) — Immutable item UUID.
6. changes[].added[].label (string) — Public model-chosen label.
7. changes[].added[].note (string|null) — Public contextual note.
8. changes[].added[].origin ("original"|"analysis") — Persisted origin in the named checked scope.
9. changes[].added[].representationId (string) — Versioned representation identity.
10. changes[].added[].representationVersion (string) — Representation algorithm version.
11. changes[].added[].selector (object|object|object|object|null) — Persisted selector in the named checked scope.
12. changes[].added[].selector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
13. changes[].added[].selector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
14. changes[].added[].selector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
15. changes[].added[].selector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
16. changes[].added[].selector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
17. changes[].added[].selector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
18. changes[].added[].selector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
19. changes[].added[].selector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
20. changes[].added[].selector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
21. changes[].added[].selector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
22. changes[].added[].selector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
23. changes[].added[].selector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
24. changes[].added[].selector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
25. changes[].added[].sourceId (string) — Conversation-bound immutable byte custody identity.
26. changes[].added[].template (string) — Canvas template name. Opaque to Carbon except original, which Carbon sets for received originals.
27. changes[].author (object) — Persisted author in the named checked scope.
28. changes[].author.displayName (string) — Publisher display name.
29. changes[].author.id (string) — Authenticated publisher.
30. changes[].changeId (string) — Immutable change UUID.
31. changes[].createdAt (string) — Server capture timestamp.
32. changes[].messageId (string) — Public ordinary conversation anchor.
33. changes[].note (string|null) — Public change explanation.
34. changes[].releaseId (string) — Actual active Carbon release.
35. changes[].removed (array<object>) — Persisted removed in the named checked scope.
36. changes[].removed[].itemId (string) — Explicit removed immutable identity.
37. changes[].removed[].reason (string) — Public removal reason.
38. changes[].revision (integer) — Persisted feedback revision, previous revisions retained.
39. changes[].turnId (string) — Actual native turn.
40. conversationId (string) — Canonical conversation.
41. cursor (integer) — Last returned persisted Carbon ordinal.
42. hasMore (boolean) — More retained messages exist after this page.
43. revision (integer) — Persisted feedback revision, previous revisions retained.

Refusals:
1. EVIDENCE_TURN_REFUSED — resolver: agent — evidence turn refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
2. EVIDENCE_SELECTOR_INVALID — resolver: agent — evidence selector invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
3. EVIDENCE_REFERENCE_STALE — resolver: agent — evidence reference stale.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
4. EVIDENCE_NOT_FOUND — resolver: agent — evidence not found.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
5. EVIDENCE_BYTES_MISSING — resolver: agent — evidence bytes missing.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
6. EVIDENCE_CHANGE_CONFLICT — resolver: agent — evidence change conflict.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
7. EVIDENCE_PATH_REFUSED — resolver: agent — evidence path refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
8. EVIDENCE_DELTA_EMPTY — resolver: agent — evidence delta empty.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
9. EVIDENCE_REMOVE_INVALID — resolver: agent — evidence remove invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
10. EVIDENCE_ITEM_CONFLICT — resolver: agent — evidence item conflict.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
11. EVIDENCE_RESOURCE_LIMIT — resolver: agent — evidence resource limit.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
12. EVIDENCE_PROVENANCE_INVALID — resolver: agent — evidence provenance invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
13. EVIDENCE_ORIGINAL_UNREGISTERED — resolver: agent — evidence original unregistered.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
14. EVIDENCE_TEMPLATE_REFUSED — resolver: agent — evidence template refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
15. ROUTE_NOT_FOUND — resolver: agent — No declared route matches this method and path.
   fix: Call a method and path from the API description.
16. METHOD_NOT_ALLOWED — resolver: agent — The path exists but this HTTP method is not declared for it.
   fix: Use one of the methods declared for this path.
17. ACTION_UNKNOWN — resolver: agent — The request action is not declared for this method and path.
   fix: Send a declared action literal, or omit action when the route has none.
18. ACTION_MISSING — resolver: agent — This method and path declare named actions and the request did not name one.
   fix: Send body.action as one of the declared action literals.
19. JSON_INVALID — resolver: agent — The request body is not valid JSON.
   fix: Send a JSON object body with the declared fields.
20. INPUT_INVALID — resolver: agent — One or more declared input fields failed structural checks.
   fix: Correct every named input fault and retry once.
21. AUTH_MISSING — resolver: principal — The request did not present a usable credential.
   fix: Send the configured service token as Authorization Bearer, or a browser session cookie.
22. AUTH_INVALID — resolver: principal — The presented credential was not accepted.
   fix: Use a configured token or session; do not guess identities in the body.
23. AUTH_SCOPE_DENIED — resolver: principal — The authenticated principal lacks this route scope.
   fix: Use a grant that lists this scope, or call a route in the granted scopes.
24. WRITE_UNCERTAIN — resolver: operator — The write ran and readback did not confirm the persisted record.
   fix: Do not retry this write; read the record and reconcile before any further call.
25. OUTPUT_INVALID — resolver: operator — The handler result did not match the declared output schema.
   fix: Return only declared fields that satisfy the output schema.
26. OUTPUT_UNDECLARED — resolver: operator — The handler result included fields the output schema does not declare.
   fix: Return exactly the declared output fields.
27. INTERNAL_ERROR — resolver: operator — The handler failed without a named route fault.
   fix: Retry only after an operator inspects the server; do not send secrets to diagnose.
28. HTTP_REDIRECT — resolver: agent — The HTTP client refused to follow a redirect while holding a bearer token.
   fix: Call the https origin that serves the API; do not use a redirecting base URL.

Example:
GET /api/evidence/changes

## evidence_fragment_read

Read exact selected source representation with explicit context and immutable original download identity.

- Method: GET
- Path: /api/evidence/fragment
- Scope: read
- Kind: read
- CLI: evidence-fragment-read
- MCP tool: evidence_fragment_read

Input fields:
1. itemId (string, query) — Exact immutable item UUID.
2. selector (object|null, query) — Explicit retained value.
3. contextBefore (integer, query) — Explicit nonnegative retained ordinal or surrounding context count.
4. contextAfter (integer, query) — Explicit nonnegative retained ordinal or surrounding context count.
5. limit (integer, query) — Explicit page/fragment resource limit.

Return fields:
1. assumptions (array<string>) — Persisted assumptions in the named checked scope.
2. basis (array<object>) — Persisted basis in the named checked scope.
3. basis[].itemId (string) — Persisted itemId in the named checked scope.
4. basis[].representationId (string) — Persisted representationId in the named checked scope.
5. basis[].representationVersion (string) — Persisted representationVersion in the named checked scope.
6. basis[].selector (object|object|object|object|null) — Persisted selector in the named checked scope.
7. basis[].selector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
8. basis[].selector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
9. basis[].selector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
10. basis[].selector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
11. basis[].selector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
12. basis[].selector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
13. basis[].selector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
14. basis[].selector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
15. basis[].selector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
16. basis[].selector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
17. basis[].selector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
18. basis[].selector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
19. basis[].selector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
20. basis[].sha256 (string) — Persisted sha256 in the named checked scope.
21. basis[].sourceId (string) — Persisted sourceId in the named checked scope.
22. content (object|object|object|object|object|object) — Persisted content in the named checked scope.
23. content (variant 1).columns (array<string>) — Persisted columns in the named checked scope.
24. content (variant 1).end (integer) — Persisted end in the named checked scope.
25. content (variant 1).hasMore (boolean) — More retained messages exist after this page.
26. content (variant 1).kind ("text") — Persisted kind in the named checked scope.
27. content (variant 1).lines (array<object>) — Persisted lines in the named checked scope.
28. content (variant 1).lines[].number (integer) — Persisted number in the named checked scope.
29. content (variant 1).lines[].text (string) — Persisted text in the named checked scope.
30. content (variant 1).nextSelector (object|object|object|object|null) — Persisted selector in the named checked scope.
31. content (variant 1).nextSelector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
32. content (variant 1).nextSelector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
33. content (variant 1).nextSelector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
34. content (variant 1).nextSelector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
35. content (variant 1).nextSelector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
36. content (variant 1).nextSelector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
37. content (variant 1).nextSelector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
38. content (variant 1).nextSelector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
39. content (variant 1).nextSelector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
40. content (variant 1).nextSelector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
41. content (variant 1).nextSelector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
42. content (variant 1).nextSelector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
43. content (variant 1).nextSelector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
44. content (variant 1).rows (array<object>) — Persisted rows in the named checked scope.
45. content (variant 1).rows[].cells (array<string>) — Persisted cells in the named checked scope.
46. content (variant 1).rows[].number (integer) — Persisted number in the named checked scope.
47. content (variant 1).start (integer) — Persisted start in the named checked scope.
48. content (variant 1).total (integer) — Persisted total in the named checked scope.
49. content (variant 2).columns (array<string>) — Persisted columns in the named checked scope.
50. content (variant 2).end (integer) — Persisted end in the named checked scope.
51. content (variant 2).hasMore (boolean) — More retained messages exist after this page.
52. content (variant 2).kind ("table") — Persisted kind in the named checked scope.
53. content (variant 2).lines (array<object>) — Persisted lines in the named checked scope.
54. content (variant 2).lines[].number (integer) — Persisted number in the named checked scope.
55. content (variant 2).lines[].text (string) — Persisted text in the named checked scope.
56. content (variant 2).nextSelector (object|object|object|object|null) — Persisted selector in the named checked scope.
57. content (variant 2).nextSelector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
58. content (variant 2).nextSelector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
59. content (variant 2).nextSelector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
60. content (variant 2).nextSelector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
61. content (variant 2).nextSelector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
62. content (variant 2).nextSelector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
63. content (variant 2).nextSelector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
64. content (variant 2).nextSelector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
65. content (variant 2).nextSelector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
66. content (variant 2).nextSelector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
67. content (variant 2).nextSelector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
68. content (variant 2).nextSelector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
69. content (variant 2).nextSelector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
70. content (variant 2).rows (array<object>) — Persisted rows in the named checked scope.
71. content (variant 2).rows[].cells (array<string>) — Persisted cells in the named checked scope.
72. content (variant 2).rows[].number (integer) — Persisted number in the named checked scope.
73. content (variant 2).start (integer) — Persisted start in the named checked scope.
74. content (variant 2).total (integer) — Persisted total in the named checked scope.
75. content (variant 3).hasMore (boolean) — More retained messages exist after this page.
76. content (variant 3).kind ("json") — Persisted kind in the named checked scope.
77. content (variant 3).nextSelector (object|object|object|object|null) — Persisted selector in the named checked scope.
78. content (variant 3).nextSelector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
79. content (variant 3).nextSelector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
80. content (variant 3).nextSelector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
81. content (variant 3).nextSelector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
82. content (variant 3).nextSelector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
83. content (variant 3).nextSelector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
84. content (variant 3).nextSelector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
85. content (variant 3).nextSelector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
86. content (variant 3).nextSelector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
87. content (variant 3).nextSelector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
88. content (variant 3).nextSelector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
89. content (variant 3).nextSelector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
90. content (variant 3).nextSelector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
91. content (variant 3).pointer (string) — Persisted pointer in the named checked scope.
92. content (variant 3).text (string) — Persisted text in the named checked scope.
93. content (variant 4).hasMore (boolean) — More retained messages exist after this page.
94. content (variant 4).height (integer) — Persisted height in the named checked scope.
95. content (variant 4).kind ("image") — Persisted kind in the named checked scope.
96. content (variant 4).nextSelector (object|object|object|object|null) — Persisted selector in the named checked scope.
97. content (variant 4).nextSelector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
98. content (variant 4).nextSelector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
99. content (variant 4).nextSelector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
100. content (variant 4).nextSelector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
101. content (variant 4).nextSelector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
102. content (variant 4).nextSelector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
103. content (variant 4).nextSelector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
104. content (variant 4).nextSelector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
105. content (variant 4).nextSelector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
106. content (variant 4).nextSelector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
107. content (variant 4).nextSelector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
108. content (variant 4).nextSelector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
109. content (variant 4).nextSelector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
110. content (variant 4).region (object|object|object|object|null) — Persisted selector in the named checked scope.
111. content (variant 4).region (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
112. content (variant 4).region (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
113. content (variant 4).region (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
114. content (variant 4).region (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
115. content (variant 4).region (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
116. content (variant 4).region (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
117. content (variant 4).region (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
118. content (variant 4).region (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
119. content (variant 4).region (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
120. content (variant 4).region (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
121. content (variant 4).region (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
122. content (variant 4).region (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
123. content (variant 4).region (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
124. content (variant 4).width (integer) — Persisted width in the named checked scope.
125. content (variant 5).hasMore (boolean) — More retained messages exist after this page.
126. content (variant 5).kind ("file") — Persisted kind in the named checked scope.
127. content (variant 5).limitation (string|null) — Explicit unsupported display reason.
128. content (variant 5).nextSelector (object|object|object|object|null) — Persisted selector in the named checked scope.
129. content (variant 5).nextSelector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
130. content (variant 5).nextSelector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
131. content (variant 5).nextSelector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
132. content (variant 5).nextSelector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
133. content (variant 5).nextSelector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
134. content (variant 5).nextSelector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
135. content (variant 5).nextSelector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
136. content (variant 5).nextSelector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
137. content (variant 5).nextSelector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
138. content (variant 5).nextSelector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
139. content (variant 5).nextSelector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
140. content (variant 5).nextSelector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
141. content (variant 5).nextSelector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
142. content (variant 6).kind ("unavailable") — Persisted kind in the named checked scope.
143. content (variant 6).reason (string) — Retained-byte availability limitation.
144. conversationId (string) — Canonical conversation.
145. download (object|null) — Persisted download in the named checked scope.
146. download.conversationId (string) — Exact bound conversation.
147. download.path ("/api/evidence/download") — Persisted path in the named checked scope.
148. download.sourceId (string) — Immutable accepted source identity.
149. item (object) — Persisted item in the named checked scope.
150. item.changeId (string) — Explicit publishing change UUID.
151. item.digest (string) — Original exact byte SHA256.
152. item.id (string) — Immutable item UUID.
153. item.label (string) — Public model-chosen label.
154. item.note (string|null) — Public contextual note.
155. item.origin ("original"|"analysis") — Persisted origin in the named checked scope.
156. item.representationId (string) — Versioned representation identity.
157. item.representationVersion (string) — Representation algorithm version.
158. item.selector (object|object|object|object|null) — Persisted selector in the named checked scope.
159. item.selector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
160. item.selector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
161. item.selector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
162. item.selector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
163. item.selector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
164. item.selector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
165. item.selector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
166. item.selector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
167. item.selector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
168. item.selector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
169. item.selector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
170. item.selector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
171. item.selector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
172. item.sourceId (string) — Conversation-bound immutable byte custody identity.
173. item.template (string) — Canvas template name. Opaque to Carbon except original, which Carbon sets for received originals.
174. producer (object|null) — Persisted producer in the named checked scope.
175. producer.conversationId (string) — Exact bound conversation.
176. producer.path ("/api/evidence/download") — Persisted path in the named checked scope.
177. producer.sourceId (string) — Immutable accepted source identity.
178. provenance (object|null) — Persisted provenance in the named checked scope.
179. provenance.completeness (string|null) — Original source receipt completeness.
180. provenance.conversion (string|null) — Original source receipt conversion.
181. provenance.fetchedAt (string|null) — Original source receipt fetchedAt.
182. provenance.locator (string|null) — Original source receipt locator.
183. provenance.revision (string|null) — Original source receipt revision.
184. provenance.sha256 (string|null) — Original source receipt sha256.
185. provenance.source (string|null) — Original source receipt source.
186. reference (object) — Persisted reference in the named checked scope.
187. reference.itemId (string) — Persisted itemId in the named checked scope.
188. reference.representationId (string) — Persisted representationId in the named checked scope.
189. reference.representationVersion (string) — Persisted representationVersion in the named checked scope.
190. reference.selector (object|object|object|object|null) — Persisted selector in the named checked scope.
191. reference.selector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
192. reference.selector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
193. reference.selector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
194. reference.selector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
195. reference.selector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
196. reference.selector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
197. reference.selector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
198. reference.selector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
199. reference.selector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
200. reference.selector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
201. reference.selector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
202. reference.selector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
203. reference.selector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
204. reference.sha256 (string) — Persisted sha256 in the named checked scope.
205. reference.sourceId (string) — Persisted sourceId in the named checked scope.
206. status ("available"|"unavailable") — Persisted status in the named checked scope.
207. upstreamHref (string|null) — Safe original upstream URL where supplied; no local paths or credentials.

Refusals:
1. EVIDENCE_TURN_REFUSED — resolver: agent — evidence turn refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
2. EVIDENCE_SELECTOR_INVALID — resolver: agent — evidence selector invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
3. EVIDENCE_REFERENCE_STALE — resolver: agent — evidence reference stale.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
4. EVIDENCE_NOT_FOUND — resolver: agent — evidence not found.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
5. EVIDENCE_BYTES_MISSING — resolver: agent — evidence bytes missing.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
6. EVIDENCE_CHANGE_CONFLICT — resolver: agent — evidence change conflict.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
7. EVIDENCE_PATH_REFUSED — resolver: agent — evidence path refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
8. EVIDENCE_DELTA_EMPTY — resolver: agent — evidence delta empty.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
9. EVIDENCE_REMOVE_INVALID — resolver: agent — evidence remove invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
10. EVIDENCE_ITEM_CONFLICT — resolver: agent — evidence item conflict.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
11. EVIDENCE_RESOURCE_LIMIT — resolver: agent — evidence resource limit.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
12. EVIDENCE_PROVENANCE_INVALID — resolver: agent — evidence provenance invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
13. EVIDENCE_ORIGINAL_UNREGISTERED — resolver: agent — evidence original unregistered.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
14. EVIDENCE_TEMPLATE_REFUSED — resolver: agent — evidence template refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
15. ROUTE_NOT_FOUND — resolver: agent — No declared route matches this method and path.
   fix: Call a method and path from the API description.
16. METHOD_NOT_ALLOWED — resolver: agent — The path exists but this HTTP method is not declared for it.
   fix: Use one of the methods declared for this path.
17. ACTION_UNKNOWN — resolver: agent — The request action is not declared for this method and path.
   fix: Send a declared action literal, or omit action when the route has none.
18. ACTION_MISSING — resolver: agent — This method and path declare named actions and the request did not name one.
   fix: Send body.action as one of the declared action literals.
19. JSON_INVALID — resolver: agent — The request body is not valid JSON.
   fix: Send a JSON object body with the declared fields.
20. INPUT_INVALID — resolver: agent — One or more declared input fields failed structural checks.
   fix: Correct every named input fault and retry once.
21. AUTH_MISSING — resolver: principal — The request did not present a usable credential.
   fix: Send the configured service token as Authorization Bearer, or a browser session cookie.
22. AUTH_INVALID — resolver: principal — The presented credential was not accepted.
   fix: Use a configured token or session; do not guess identities in the body.
23. AUTH_SCOPE_DENIED — resolver: principal — The authenticated principal lacks this route scope.
   fix: Use a grant that lists this scope, or call a route in the granted scopes.
24. WRITE_UNCERTAIN — resolver: operator — The write ran and readback did not confirm the persisted record.
   fix: Do not retry this write; read the record and reconcile before any further call.
25. OUTPUT_INVALID — resolver: operator — The handler result did not match the declared output schema.
   fix: Return only declared fields that satisfy the output schema.
26. OUTPUT_UNDECLARED — resolver: operator — The handler result included fields the output schema does not declare.
   fix: Return exactly the declared output fields.
27. INTERNAL_ERROR — resolver: operator — The handler failed without a named route fault.
   fix: Retry only after an operator inspects the server; do not send secrets to diagnose.
28. HTTP_REDIRECT — resolver: agent — The HTTP client refused to follow a redirect while holding a bearer token.
   fix: Call the https origin that serves the API; do not use a redirecting base URL.

Example:
GET /api/evidence/fragment

## evidence_present

Publish one explicit evidence delta on the exact currently executing native turn; final reply fence is unchanged.

- Method: POST
- Path: /api/evidence/present
- Scope: write
- Kind: create
- CLI: evidence-present
- MCP tool: evidence_present

Input fields:
1. changeId (string, body) — Explicit retained changeId.
2. add (array<object>, body) — Explicit retained add.
3. remove (array<object>, body) — Explicit retained remove.
4. note (string|null, body) — Explicit retained note.

Return fields:
1. added (array<object>) — Persisted added in the named checked scope.
2. added[].changeId (string) — Explicit publishing change UUID.
3. added[].digest (string) — Original exact byte SHA256.
4. added[].id (string) — Immutable item UUID.
5. added[].label (string) — Public model-chosen label.
6. added[].note (string|null) — Public contextual note.
7. added[].origin ("original"|"analysis") — Persisted origin in the named checked scope.
8. added[].representationId (string) — Versioned representation identity.
9. added[].representationVersion (string) — Representation algorithm version.
10. added[].selector (object|object|object|object|null) — Persisted selector in the named checked scope.
11. added[].selector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
12. added[].selector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
13. added[].selector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
14. added[].selector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
15. added[].selector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
16. added[].selector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
17. added[].selector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
18. added[].selector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
19. added[].selector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
20. added[].selector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
21. added[].selector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
22. added[].selector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
23. added[].selector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
24. added[].sourceId (string) — Conversation-bound immutable byte custody identity.
25. added[].template (string) — Canvas template name. Opaque to Carbon except original, which Carbon sets for received originals.
26. author (object) — Persisted author in the named checked scope.
27. author.displayName (string) — Publisher display name.
28. author.id (string) — Authenticated publisher.
29. changeId (string) — Immutable change UUID.
30. createdAt (string) — Server capture timestamp.
31. messageId (string) — Public ordinary conversation anchor.
32. note (string|null) — Public change explanation.
33. releaseId (string) — Actual active Carbon release.
34. removed (array<object>) — Persisted removed in the named checked scope.
35. removed[].itemId (string) — Explicit removed immutable identity.
36. removed[].reason (string) — Public removal reason.
37. revision (integer) — Persisted feedback revision, previous revisions retained.
38. turnId (string) — Actual native turn.
39. duplicate (boolean) — Exact previously retained change identity/payload was reused.

Refusals:
1. EVIDENCE_TURN_REFUSED — resolver: agent — evidence turn refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
2. EVIDENCE_SELECTOR_INVALID — resolver: agent — evidence selector invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
3. EVIDENCE_REFERENCE_STALE — resolver: agent — evidence reference stale.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
4. EVIDENCE_NOT_FOUND — resolver: agent — evidence not found.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
5. EVIDENCE_BYTES_MISSING — resolver: agent — evidence bytes missing.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
6. EVIDENCE_CHANGE_CONFLICT — resolver: agent — evidence change conflict.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
7. EVIDENCE_PATH_REFUSED — resolver: agent — evidence path refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
8. EVIDENCE_DELTA_EMPTY — resolver: agent — evidence delta empty.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
9. EVIDENCE_REMOVE_INVALID — resolver: agent — evidence remove invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
10. EVIDENCE_ITEM_CONFLICT — resolver: agent — evidence item conflict.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
11. EVIDENCE_RESOURCE_LIMIT — resolver: agent — evidence resource limit.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
12. EVIDENCE_PROVENANCE_INVALID — resolver: agent — evidence provenance invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
13. EVIDENCE_ORIGINAL_UNREGISTERED — resolver: agent — evidence original unregistered.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
14. EVIDENCE_TEMPLATE_REFUSED — resolver: agent — evidence template refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
15. ROUTE_NOT_FOUND — resolver: agent — No declared route matches this method and path.
   fix: Call a method and path from the API description.
16. METHOD_NOT_ALLOWED — resolver: agent — The path exists but this HTTP method is not declared for it.
   fix: Use one of the methods declared for this path.
17. ACTION_UNKNOWN — resolver: agent — The request action is not declared for this method and path.
   fix: Send a declared action literal, or omit action when the route has none.
18. ACTION_MISSING — resolver: agent — This method and path declare named actions and the request did not name one.
   fix: Send body.action as one of the declared action literals.
19. JSON_INVALID — resolver: agent — The request body is not valid JSON.
   fix: Send a JSON object body with the declared fields.
20. INPUT_INVALID — resolver: agent — One or more declared input fields failed structural checks.
   fix: Correct every named input fault and retry once.
21. AUTH_MISSING — resolver: principal — The request did not present a usable credential.
   fix: Send the configured service token as Authorization Bearer, or a browser session cookie.
22. AUTH_INVALID — resolver: principal — The presented credential was not accepted.
   fix: Use a configured token or session; do not guess identities in the body.
23. AUTH_SCOPE_DENIED — resolver: principal — The authenticated principal lacks this route scope.
   fix: Use a grant that lists this scope, or call a route in the granted scopes.
24. WRITE_UNCERTAIN — resolver: operator — The write ran and readback did not confirm the persisted record.
   fix: Do not retry this write; read the record and reconcile before any further call.
25. OUTPUT_INVALID — resolver: operator — The handler result did not match the declared output schema.
   fix: Return only declared fields that satisfy the output schema.
26. OUTPUT_UNDECLARED — resolver: operator — The handler result included fields the output schema does not declare.
   fix: Return exactly the declared output fields.
27. INTERNAL_ERROR — resolver: operator — The handler failed without a named route fault.
   fix: Retry only after an operator inspects the server; do not send secrets to diagnose.
28. HTTP_REDIRECT — resolver: agent — The HTTP client refused to follow a redirect while holding a bearer token.
   fix: Call the https origin that serves the API; do not use a redirecting base URL.

Example:
POST /api/evidence/present
{"changeId":"<value>","add":[],"remove":[],"note":"<value>"}

## evidence_read

Read a compact current set or one immutable conversation anchor, then detail on demand.

- Method: GET
- Path: /api/evidence
- Scope: read
- Kind: read
- CLI: evidence-read
- MCP tool: evidence_read

Input fields:
1. anchor (string|null, query) — Exact anchor or null for current.
2. cursor (integer, query) — Explicit nonnegative retained ordinal or surrounding context count.
3. limit (integer, query) — Explicit page/fragment resource limit.

Return fields:
1. anchor (string|null) — Fixed snapshot anchor, null only when empty.
2. conversationId (string) — Canonical conversation.
3. cursor (integer) — Last returned persisted Carbon ordinal.
4. hasMore (boolean) — More retained messages exist after this page.
5. items (array<object>) — Persisted items in the named checked scope.
6. items[].changeId (string) — Explicit publishing change UUID.
7. items[].digest (string) — Original exact byte SHA256.
8. items[].id (string) — Immutable item UUID.
9. items[].label (string) — Public model-chosen label.
10. items[].note (string|null) — Public contextual note.
11. items[].origin ("original"|"analysis") — Persisted origin in the named checked scope.
12. items[].representationId (string) — Versioned representation identity.
13. items[].representationVersion (string) — Representation algorithm version.
14. items[].selector (object|object|object|object|null) — Persisted selector in the named checked scope.
15. items[].selector (variant 1) (variant 1).end (integer) — Persisted end in the named checked scope.
16. items[].selector (variant 1) (variant 1).kind ("lines") — Persisted kind in the named checked scope.
17. items[].selector (variant 1) (variant 1).start (integer) — Persisted start in the named checked scope.
18. items[].selector (variant 1) (variant 2).end (integer) — Persisted end in the named checked scope.
19. items[].selector (variant 1) (variant 2).kind ("rows") — Persisted kind in the named checked scope.
20. items[].selector (variant 1) (variant 2).start (integer) — Persisted start in the named checked scope.
21. items[].selector (variant 1) (variant 3).kind ("field") — Persisted kind in the named checked scope.
22. items[].selector (variant 1) (variant 3).pointer (string) — Persisted pointer in the named checked scope.
23. items[].selector (variant 1) (variant 4).height (number) — Persisted height in the named checked scope.
24. items[].selector (variant 1) (variant 4).kind ("region") — Persisted kind in the named checked scope.
25. items[].selector (variant 1) (variant 4).width (number) — Persisted width in the named checked scope.
26. items[].selector (variant 1) (variant 4).x (number) — Persisted x in the named checked scope.
27. items[].selector (variant 1) (variant 4).y (number) — Persisted y in the named checked scope.
28. items[].sourceId (string) — Conversation-bound immutable byte custody identity.
29. items[].template (string) — Canvas template name. Opaque to Carbon except original, which Carbon sets for received originals.
30. revision (integer) — Persisted feedback revision, previous revisions retained.
31. total (integer) — Persisted total in the named checked scope.

Refusals:
1. EVIDENCE_TURN_REFUSED — resolver: agent — evidence turn refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
2. EVIDENCE_SELECTOR_INVALID — resolver: agent — evidence selector invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
3. EVIDENCE_REFERENCE_STALE — resolver: agent — evidence reference stale.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
4. EVIDENCE_NOT_FOUND — resolver: agent — evidence not found.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
5. EVIDENCE_BYTES_MISSING — resolver: agent — evidence bytes missing.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
6. EVIDENCE_CHANGE_CONFLICT — resolver: agent — evidence change conflict.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
7. EVIDENCE_PATH_REFUSED — resolver: agent — evidence path refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
8. EVIDENCE_DELTA_EMPTY — resolver: agent — evidence delta empty.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
9. EVIDENCE_REMOVE_INVALID — resolver: agent — evidence remove invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
10. EVIDENCE_ITEM_CONFLICT — resolver: agent — evidence item conflict.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
11. EVIDENCE_RESOURCE_LIMIT — resolver: agent — evidence resource limit.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
12. EVIDENCE_PROVENANCE_INVALID — resolver: agent — evidence provenance invalid.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
13. EVIDENCE_ORIGINAL_UNREGISTERED — resolver: agent — evidence original unregistered.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
14. EVIDENCE_TEMPLATE_REFUSED — resolver: agent — evidence template refused.
   fix: Read the exact current evidence and repair all named fields; only the executing turn may publish. Never replace original custody with reconstructed metadata.
15. ROUTE_NOT_FOUND — resolver: agent — No declared route matches this method and path.
   fix: Call a method and path from the API description.
16. METHOD_NOT_ALLOWED — resolver: agent — The path exists but this HTTP method is not declared for it.
   fix: Use one of the methods declared for this path.
17. ACTION_UNKNOWN — resolver: agent — The request action is not declared for this method and path.
   fix: Send a declared action literal, or omit action when the route has none.
18. ACTION_MISSING — resolver: agent — This method and path declare named actions and the request did not name one.
   fix: Send body.action as one of the declared action literals.
19. JSON_INVALID — resolver: agent — The request body is not valid JSON.
   fix: Send a JSON object body with the declared fields.
20. INPUT_INVALID — resolver: agent — One or more declared input fields failed structural checks.
   fix: Correct every named input fault and retry once.
21. AUTH_MISSING — resolver: principal — The request did not present a usable credential.
   fix: Send the configured service token as Authorization Bearer, or a browser session cookie.
22. AUTH_INVALID — resolver: principal — The presented credential was not accepted.
   fix: Use a configured token or session; do not guess identities in the body.
23. AUTH_SCOPE_DENIED — resolver: principal — The authenticated principal lacks this route scope.
   fix: Use a grant that lists this scope, or call a route in the granted scopes.
24. WRITE_UNCERTAIN — resolver: operator — The write ran and readback did not confirm the persisted record.
   fix: Do not retry this write; read the record and reconcile before any further call.
25. OUTPUT_INVALID — resolver: operator — The handler result did not match the declared output schema.
   fix: Return only declared fields that satisfy the output schema.
26. OUTPUT_UNDECLARED — resolver: operator — The handler result included fields the output schema does not declare.
   fix: Return exactly the declared output fields.
27. INTERNAL_ERROR — resolver: operator — The handler failed without a named route fault.
   fix: Retry only after an operator inspects the server; do not send secrets to diagnose.
28. HTTP_REDIRECT — resolver: agent — The HTTP client refused to follow a redirect while holding a bearer token.
   fix: Call the https origin that serves the API; do not use a redirecting base URL.

Example:
GET /api/evidence

# docs/ — engineering notes

| File | Read it for |
|---|---|
| `DESIGN.md` | Why each part is built the way it is: the decision, the alternatives considered and the known limits, one section per part of the app. This is the source for the architecture discussion and the reviewer questions in the assignment |
| `VERIFICATION.md` | What is implemented against the assignment's requirement ids, the automated test counts, and the live development-store checklists with the evidence collected so far |
| `SUBMISSION.md` | The submission document: architecture note with diagram and the four flows, database documentation with ER diagram and constraints, `/api/v1` endpoint reference with Postman captures, and test evidence (command results, what is mocked and what is real, manual dev-store checks) |
| `diagrams/` | `architecture.png` and `er-diagram.png`, embedded in `SUBMISSION.md`. The Mermaid source sits next to each image in that file |
| `postman/` | Six Postman captures of the developer API against the real development store, embedded in `SUBMISSION.md`. The Bearer token is masked in every capture; keep it that way when adding more |

How each folder works today is in that folder's `README.md`, not here.

Still to write for submission: OpenAPI file for `/api/v1`, demo, time spent.

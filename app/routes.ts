import { flatRoutes } from "@react-router/fs-routes";

// Context docs (README.md / AGENTS.md / CLAUDE.md) live beside the routes; they are not routes.
export default flatRoutes({ ignoredRouteFiles: ["**/*.md"] });

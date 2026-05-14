# Job Copilot dev shortcuts.
# Run `make help` to see what's available.

.PHONY: help dev stop logs bump health frontend frontend-stop

PORT ?= 8000
FRONTEND_DIR ?= $(HOME)/Developer/revops-os-mvp
FRONTEND_PORT ?= 3000

help:  ## show this help
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(MAKEFILE_LIST) \
		| awk -F':.*## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

dev:  ## start backend with hot reload (frees :$(PORT) first)
	@./dev.sh

stop:  ## kill whatever is on :$(PORT)
	@./bin/stop.sh

logs:  ## tail the dev log
	@tail -n 200 -f logs/dev.log

bump:  ## bump the chrome extension version (so reload actually picks up changes)
	@./bin/bump-extension.sh

health:  ## quick curl of the backend
	@curl -fsS "http://127.0.0.1:$(PORT)/" >/dev/null \
		&& echo "backend up on :$(PORT)" \
		|| echo "backend NOT responding on :$(PORT)"

frontend:  ## start the Next.js dashboard (revops-os-mvp) — run in a second terminal
	@if [ ! -d "$(FRONTEND_DIR)" ]; then \
		echo "frontend dir not found at $(FRONTEND_DIR)"; exit 1; \
	fi
	@if lsof -ti tcp:$(FRONTEND_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "[frontend] killing stale process on :$(FRONTEND_PORT)"; \
		lsof -ti tcp:$(FRONTEND_PORT) -sTCP:LISTEN | xargs kill -9 2>/dev/null || true; \
	fi
	@echo "[frontend] cd $(FRONTEND_DIR) && npm run dev → http://localhost:$(FRONTEND_PORT)"
	@cd "$(FRONTEND_DIR)" && npm run dev

frontend-stop:  ## kill whatever is on :$(FRONTEND_PORT)
	@pids=$$(lsof -ti tcp:$(FRONTEND_PORT) -sTCP:LISTEN 2>/dev/null); \
	if [ -z "$$pids" ]; then echo "nothing on :$(FRONTEND_PORT)"; \
	else echo "killing $$pids"; echo "$$pids" | xargs kill -9 2>/dev/null || true; fi

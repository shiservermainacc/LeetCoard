"""FastAPI application entrypoint."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .core.config import get_settings
from .core.sse import broadcaster
from .core.storage import ContestStore
from .domain.state import ContestEngine
from .integrations.leetcode import LeetCodeClient
from .routes import admin as admin_routes
from .routes import public as public_routes
from .workers.polling import PollingWorker
from .workers.scheduler import ContestScheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
log = logging.getLogger("gdg.main")
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    log.info("Starting backend sessions=%d", len(settings.session_list))

    settings.data_dir.mkdir(parents=True, exist_ok=True)
    store = ContestStore(settings.state_file, settings.state_backup_file)
    store.load_sync()

    engine = ContestEngine(store, broadcaster, settings)
    app.state.engine = engine

    client = LeetCodeClient(
        api_base=settings.leetcode_api_base,
        sessions=settings.session_list,
        timeout=settings.leetcode_http_timeout_sec,
    )
    await client.__aenter__()
    app.state.lc_client = client

    polling = PollingWorker(engine, client, settings)
    await polling.start()

    scheduler = ContestScheduler(engine)
    await scheduler.start()

    app.state.polling_worker = polling
    app.state.scheduler = scheduler

    # Best-effort one-shot backfill: legacy problems may lack frontend_id.
    asyncio.create_task(engine.backfill_problem_metadata(client.get_problem))

    try:
        yield
    finally:
        log.info("Shutting down workers")
        for worker in (scheduler, polling):
            try:
                await worker.stop()
            except Exception:
                log.exception("worker stop failed")
        await store.flush_now()
        await client.aclose()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="GDG NTUST · LeetCode Contest API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_list,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(public_routes.router, prefix="/api", tags=["public"])
    app.include_router(admin_routes.router, prefix="/api/admin", tags=["admin"])

    # Register the frontend after API routes so it cannot shadow them.
    dist_dir = FRONTEND_DIST.resolve()
    index_file = dist_dir / "index.html"
    assets_dir = dist_dir / "assets"

    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")
    if not index_file.is_file():
        log.warning(
            "Frontend build not found at %s; API will start without the React UI. "
            "Build it with `npm --prefix frontend run build`.",
            index_file,
        )

    def serve_frontend(path: str = ""):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        if not index_file.is_file():
            return PlainTextResponse(
                "Frontend build not found. Run `npm --prefix frontend run build`.",
                status_code=503,
            )

        if path:
            candidate = (dist_dir / path).resolve()
            try:
                candidate.relative_to(dist_dir)
            except ValueError:
                raise HTTPException(status_code=404, detail="Not Found") from None
            if candidate.is_file():
                return FileResponse(candidate)
            # Missing file-like paths (for example, JS/CSS assets) should stay
            # 404s instead of receiving the React document.
            if Path(path).suffix:
                raise HTTPException(status_code=404, detail="Not Found")

        return FileResponse(index_file)

    def frontend_index():
        return serve_frontend()

    app.add_api_route(
        "/", frontend_index, methods=["GET"], include_in_schema=False, name="frontend-index"
    )
    app.add_api_route(
        "/{path:path}",
        serve_frontend,
        methods=["GET"],
        include_in_schema=False,
        name="frontend-spa-fallback",
    )
    return app


app = create_app()


def cli() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8080,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    cli()

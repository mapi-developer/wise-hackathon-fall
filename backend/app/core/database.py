import os
from collections.abc import AsyncGenerator
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv(
    "DATABASE_URL", 
    "postgresql+asyncpg://postgres:postgres@localhost:5432/unbound"
)

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    future=True,
    pool_size=10,
    max_overflow=20
)

async_session_maker = sessionmaker(
    engine, 
    class_=AsyncSession, 
    expire_on_commit=False
)

# create_all only creates missing tables; columns added to existing tables go here.
# Each statement must be idempotent: they all run on every start.
MIGRATIONS = [
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_id VARCHAR",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source VARCHAR NOT NULL DEFAULT 'user'",
    "CREATE INDEX IF NOT EXISTS ix_tasks_plan_id ON tasks (plan_id)",
    "ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS provider VARCHAR NOT NULL DEFAULT 'anthropic'",
    # journeys
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS journey_id VARCHAR REFERENCES journeys(id)",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT 'personal'",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seq INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description VARCHAR",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requirement_key VARCHAR",
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS done_at TIMESTAMP WITH TIME ZONE",
    "CREATE INDEX IF NOT EXISTS ix_tasks_journey_id ON tasks (journey_id)",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS journey_id VARCHAR REFERENCES journeys(id)",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS fee_key VARCHAR",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount VARCHAR",
    "ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR NOT NULL DEFAULT 'EUR'",
    "ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS journey_id VARCHAR REFERENCES journeys(id)",
    "ALTER TABLE prefilled_forms ADD COLUMN IF NOT EXISTS journey_id VARCHAR REFERENCES journeys(id)",
    "ALTER TABLE journeys ADD COLUMN IF NOT EXISTS chat_id VARCHAR",
    "CREATE INDEX IF NOT EXISTS ix_journeys_chat_id ON journeys (chat_id)",
    # worker queue + pipeline
    "ALTER TABLE document_analyses ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE country_guidelines ADD COLUMN IF NOT EXISTS managed_by VARCHAR NOT NULL DEFAULT 'manual'",
    "ALTER TABLE country_guidelines ADD COLUMN IF NOT EXISTS source_hash VARCHAR",
    "ALTER TABLE country_guidelines ADD COLUMN IF NOT EXISTS checked_at TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS nationality_code VARCHAR NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS residence_code VARCHAR NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS travel_purpose VARCHAR NOT NULL DEFAULT 'tourism'",
    "ALTER TABLE country_guidelines ADD COLUMN IF NOT EXISTS entry_type VARCHAR",
]


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
        for statement in MIGRATIONS:
            await conn.execute(text(statement))

async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session
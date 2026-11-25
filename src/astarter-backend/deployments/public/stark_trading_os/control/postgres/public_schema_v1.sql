-- Dedicated PUBLIC database only. Does not extend the frozen private PG2 catalog.
DO $public_access$ BEGIN
 EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database());
END $public_access$;
CREATE SCHEMA public_data;
REVOKE ALL ON SCHEMA public_data FROM PUBLIC;
CREATE TABLE public_data.snapshots (
 resource text NOT NULL CHECK(resource IN ('markets','assets','news','explorer/capabilities')),
 mode text NOT NULL CHECK(mode IN ('offline_fixture','live_readonly')),
 tenant_scope text NOT NULL DEFAULT 'PUBLIC' CHECK(tenant_scope='PUBLIC'),
 schema_version text NOT NULL DEFAULT 'AstarterPublicData.v1' CHECK(schema_version='AstarterPublicData.v1'),
 projection_version text NOT NULL DEFAULT 'public-data-projection.v1' CHECK(projection_version='public-data-projection.v1'),
 revision bigint NOT NULL CHECK(revision>0),
 fetched_at_ms bigint NOT NULL CHECK(fetched_at_ms BETWEEN 0 AND 253402300799999),
 refresh_at_ms bigint NOT NULL CHECK(refresh_at_ms BETWEEN fetched_at_ms AND 253402300799999),
 payload_json text NOT NULL CHECK(octet_length(payload_json)<=1048576 AND jsonb_typeof(payload_json::jsonb)='object'),
 last_good_json text CHECK(last_good_json IS NULL OR (octet_length(last_good_json)<=1048576 AND jsonb_typeof(last_good_json::jsonb)='object')),
 CHECK(coalesce(payload_json::jsonb->>'mode'=mode,false)),
 CHECK(coalesce((payload_json::jsonb->>'quality'='unavailable')=(last_good_json IS NULL),false)),
 PRIMARY KEY(resource,mode)
);
CREATE TABLE public_data.budgets (
 scope text NOT NULL CHECK(scope IN ('binance','coingecko','blockbeats')),
 mode text NOT NULL CHECK(mode IN ('offline_fixture','live_readonly')),
 daily_cap bigint NOT NULL CHECK(daily_cap BETWEEN 0 AND 1000000000),
 total_cap bigint NOT NULL CHECK(total_cap BETWEEN 0 AND 1000000000),
 valid_until_ms bigint NOT NULL CHECK(valid_until_ms BETWEEN 1 AND 253402300799999),
 interval_ms bigint NOT NULL CHECK(interval_ms BETWEEN 10000 AND 31622400000),
 weight integer NOT NULL CHECK((scope='binance' AND weight=3) OR (scope IN ('coingecko','blockbeats') AND weight=1)),
 day bigint NOT NULL DEFAULT 0 CHECK(day BETWEEN 0 AND 2932896),
 reserved bigint NOT NULL DEFAULT 0 CHECK(reserved BETWEEN 0 AND daily_cap),
 total_reserved bigint NOT NULL DEFAULT 0 CHECK(total_reserved BETWEEN reserved AND total_cap),
 last_wall_ms bigint NOT NULL DEFAULT 0 CHECK(last_wall_ms BETWEEN 0 AND 253402300799999),
 next_at_ms bigint NOT NULL DEFAULT 0 CHECK(next_at_ms BETWEEN 0 AND 253402300799999),
 epoch bigint NOT NULL DEFAULT 0 CHECK(epoch>=0),
 active_request uuid,
 CHECK(day<=last_wall_ms/86400000),
 CHECK((scope='binance' AND interval_ms>=10000) OR (scope='coingecko' AND interval_ms>=300000) OR (scope='blockbeats' AND interval_ms>=60000)),
 PRIMARY KEY(scope,mode)
);
CREATE TABLE public_data.attempts (
 request_id uuid NOT NULL,
 mode text NOT NULL,
 scope text NOT NULL,
 epoch bigint NOT NULL CHECK(epoch>0),
 owner_id uuid NOT NULL,
 started_at_ms bigint NOT NULL CHECK(started_at_ms BETWEEN 0 AND 253402300799999),
 lease_until_ms bigint NOT NULL CHECK(lease_until_ms>started_at_ms AND lease_until_ms<=253402300799999),
 state text NOT NULL CHECK(state IN ('RESERVED','COMPLETED','UNKNOWN','EXPIRED')),
 deadline_ms bigint CHECK(deadline_ms BETWEEN 0 AND 253402300799999),
 revision bigint CHECK(revision>0),
 PRIMARY KEY(request_id,mode),
 UNIQUE(scope,mode,epoch),
 FOREIGN KEY(scope,mode) REFERENCES public_data.budgets(scope,mode),
 CHECK((state='COMPLETED')=(revision IS NOT NULL))
);
GRANT USAGE ON SCHEMA public_data TO public_data_read, public_data_collect;
GRANT SELECT ON public_data.snapshots TO public_data_read, public_data_collect;
GRANT SELECT ON public_data.budgets, public_data.attempts TO public_data_collect;
GRANT INSERT ON public_data.snapshots, public_data.attempts TO public_data_collect;
GRANT UPDATE(revision,fetched_at_ms,refresh_at_ms,payload_json,last_good_json) ON public_data.snapshots TO public_data_collect;
GRANT UPDATE(day,reserved,total_reserved,last_wall_ms,next_at_ms,epoch,active_request) ON public_data.budgets TO public_data_collect;
GRANT UPDATE(state,revision,deadline_ms) ON public_data.attempts TO public_data_collect;

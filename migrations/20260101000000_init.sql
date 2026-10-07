-- Single squashed schema for S2.
-- The runtime role `app` is NOBYPASSRLS so the row-level security policies below apply.
-- DDL and table ownership stay with the role dbmate connects as.

-- migrate:up

CREATE FUNCTION public.array_text_no_empty_and_distinct(arr text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT arr IS NOT NULL
     AND cardinality(arr) > 0
     AND NOT ('' = ANY(arr))
     AND cardinality(arr) = (SELECT count(DISTINCT u) FROM unnest(arr) AS u);
$$;

CREATE FUNCTION public.enqueue_storage_tombstone() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO storage_tombstones (id, storage_prefix)
  SELECT gen_ulid(), storage_prefix
  FROM deleted_revisions;
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.gen_ulid() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  alphabet TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ts BIGINT := (extract(epoch from clock_timestamp()) * 1000)::BIGINT;
  result TEXT := '';
  i INT;
BEGIN
  FOR i IN REVERSE 9..0 LOOP
    result := substr(alphabet, ((ts >> (i * 5)) & 31)::INT + 1, 1) || result;
  END LOOP;
  FOR i IN 0..9 LOOP
    result := result || substr(alphabet, floor(random() * 32)::INT + 1, 1);
  END LOOP;
  RETURN result;
END;
$$;

CREATE FUNCTION public.trg_oauth_grants_cascade_grant_fn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM grants WHERE id = OLD.grant_id;
  RETURN OLD;
END;
$$;

CREATE TABLE public.access_tokens (
    grant_id text NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE public.file_nodes (
    id text NOT NULL,
    user_id text NOT NULL,
    parent_id text,
    name text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    is_directory boolean DEFAULT false NOT NULL,
    content_version integer DEFAULT 0 NOT NULL,
    current_revision_id text,
    deleted_at timestamp with time zone,
    cached_size bigint,
    cached_updated_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT chk_file_nodes_content_version CHECK ((content_version >= 0)),
    CONSTRAINT chk_file_nodes_dir_no_revision CHECK (((NOT is_directory) OR (current_revision_id IS NULL)))
);

ALTER TABLE ONLY public.file_nodes FORCE ROW LEVEL SECURITY;

CREATE TABLE public.file_revisions (
    id text NOT NULL,
    node_id text NOT NULL,
    user_id text NOT NULL,
    storage_prefix text NOT NULL,
    content_type text DEFAULT 'application/octet-stream'::text NOT NULL,
    chunk_count integer NOT NULL,
    size bigint NOT NULL,
    hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_file_revisions_sizes CHECK (((size >= 0) AND (chunk_count >= 0) AND (((size = 0) AND (chunk_count = 0)) OR ((size > 0) AND (chunk_count > 0)))))
);

ALTER TABLE ONLY public.file_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE public.grant_paths (
    grant_id text NOT NULL,
    path text NOT NULL,
    access text NOT NULL,
    CONSTRAINT chk_grant_paths_path CHECK (((path = ''::text) OR ((path !~ '^/'::text) AND (path !~ '/$'::text) AND (path !~ '//'::text) AND (path !~ '(^|/)\.(/|$)'::text) AND (path !~ '(^|/)\.\.(/|$)'::text) AND (path !~ '[\n\r]'::text)))),
    CONSTRAINT grant_paths_access_check CHECK ((access = ANY (ARRAY['read'::text, 'write'::text])))
);

ALTER TABLE ONLY public.grant_paths FORCE ROW LEVEL SECURITY;

CREATE TABLE public.grants (
    id text NOT NULL,
    user_id text NOT NULL,
    base_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_grants_base_path CHECK (((base_path = '/'::text) OR ((base_path ~~ '/%'::text) AND (base_path !~~ '%..%'::text))))
);

ALTER TABLE ONLY public.grants FORCE ROW LEVEL SECURITY;

CREATE TABLE public.oauth_authorization_codes (
    code_hash text NOT NULL,
    client_id text NOT NULL,
    user_id text NOT NULL,
    redirect_uri text NOT NULL,
    scopes text[] NOT NULL,
    resource text,
    code_challenge text NOT NULL,
    code_challenge_method text NOT NULL,
    base_path text NOT NULL,
    consent_paths jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_oauth_authz_codes_base_path CHECK (((base_path = '/'::text) OR ((base_path ~~ '/%'::text) AND (base_path !~~ '%..%'::text)))),
    CONSTRAINT chk_oauth_authz_codes_consent_paths CHECK (((jsonb_typeof(consent_paths) = 'array'::text) AND (jsonb_array_length(consent_paths) > 0))),
    CONSTRAINT chk_oauth_authz_codes_scopes_nonempty CHECK (public.array_text_no_empty_and_distinct(scopes)),
    CONSTRAINT oauth_authorization_codes_code_challenge_method_check CHECK ((code_challenge_method = 'S256'::text))
);

CREATE TABLE public.oauth_clients (
    id text NOT NULL,
    client_name text NOT NULL,
    redirect_uris text[] NOT NULL,
    token_endpoint_auth_method text NOT NULL,
    client_secret_hash text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_oauth_clients_metadata_object CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT chk_oauth_clients_redirect_uris CHECK (public.array_text_no_empty_and_distinct(redirect_uris)),
    CONSTRAINT chk_oauth_clients_secret CHECK ((((token_endpoint_auth_method = 'none'::text) AND (client_secret_hash IS NULL)) OR ((token_endpoint_auth_method <> 'none'::text) AND (client_secret_hash IS NOT NULL)))),
    CONSTRAINT oauth_clients_token_endpoint_auth_method_check CHECK ((token_endpoint_auth_method = ANY (ARRAY['none'::text, 'client_secret_basic'::text])))
);

CREATE TABLE public.oauth_grants (
    grant_id text NOT NULL,
    user_id text NOT NULL,
    oauth_client_id text NOT NULL,
    oauth_requested_scopes text[] NOT NULL,
    resource text,
    CONSTRAINT chk_oauth_grants_scopes_nonempty CHECK (public.array_text_no_empty_and_distinct(oauth_requested_scopes))
);

ALTER TABLE ONLY public.oauth_grants FORCE ROW LEVEL SECURITY;

CREATE TABLE public.passkey (
    id text NOT NULL,
    name text,
    "publicKey" text NOT NULL,
    "userId" text NOT NULL,
    "credentialID" text NOT NULL,
    counter integer NOT NULL,
    "deviceType" text NOT NULL,
    "backedUp" boolean NOT NULL,
    transports text,
    "createdAt" timestamp with time zone,
    aaguid text
);

CREATE TABLE public.refresh_tokens (
    id text NOT NULL,
    grant_id text NOT NULL,
    user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revocation_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_refresh_tokens_revocation CHECK ((((revoked_at IS NULL) AND (revocation_reason IS NULL)) OR ((revoked_at IS NOT NULL) AND (revocation_reason IS NOT NULL)))),
    CONSTRAINT refresh_tokens_revocation_reason_check CHECK ((revocation_reason = 'reconsent'::text))
);

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL
);

CREATE TABLE public.storage_tombstones (
    id text DEFAULT public.gen_ulid() NOT NULL,
    storage_prefix text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."twoFactor" (
    id text NOT NULL,
    secret text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL,
    verified boolean
);

CREATE TABLE public.upload_session_chunks (
    session_id text NOT NULL,
    chunk_index integer NOT NULL,
    size integer NOT NULL,
    checksum text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_upload_session_chunks_sizes CHECK (((chunk_index >= 0) AND (size > 0) AND (size <= 4194304)))
);

ALTER TABLE ONLY public.upload_session_chunks FORCE ROW LEVEL SECURITY;

CREATE TABLE public.upload_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    node_id text NOT NULL,
    base_content_version integer NOT NULL,
    revision_id text NOT NULL,
    chunk_size integer DEFAULT 4194304 NOT NULL,
    total_size bigint NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_upload_sessions_sizes CHECK (((total_size > 0) AND (chunk_size > 0) AND (base_content_version >= 0))),
    CONSTRAINT upload_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.upload_sessions FORCE ROW LEVEL SECURITY;

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_sign_in_at timestamp with time zone,
    "twoFactorEnabled" boolean
);

CREATE TABLE public.user_grants (
    grant_id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    can_delegate boolean DEFAULT false NOT NULL,
    parent_grant_id text
);

ALTER TABLE ONLY public.user_grants FORCE ROW LEVEL SECURITY;

CREATE TABLE public.user_limits (
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    storage_limit_bytes bigint DEFAULT 0 NOT NULL,
    grant_limit integer DEFAULT 0 NOT NULL,
    revision_limit integer DEFAULT 0 NOT NULL
);

ALTER TABLE ONLY public.user_limits FORCE ROW LEVEL SECURITY;

CREATE TABLE public.user_storage (
    user_id text NOT NULL,
    bytes_used bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.user_storage FORCE ROW LEVEL SECURITY;

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.access_tokens
    ADD CONSTRAINT access_tokens_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY public.access_tokens
    ADD CONSTRAINT access_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.file_nodes
    ADD CONSTRAINT file_nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.file_nodes
    ADD CONSTRAINT file_nodes_user_id_id_key UNIQUE (user_id, id);

ALTER TABLE ONLY public.file_revisions
    ADD CONSTRAINT file_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.grant_paths
    ADD CONSTRAINT grant_paths_pkey PRIMARY KEY (grant_id, path);

ALTER TABLE ONLY public.grants
    ADD CONSTRAINT grants_id_user_id_key UNIQUE (id, user_id);

ALTER TABLE ONLY public.grants
    ADD CONSTRAINT grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_pkey PRIMARY KEY (code_hash);

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT passkey_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);

ALTER TABLE ONLY public.storage_tombstones
    ADD CONSTRAINT storage_tombstones_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public."twoFactor"
    ADD CONSTRAINT "twoFactor_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY public.upload_session_chunks
    ADD CONSTRAINT upload_session_chunks_pkey PRIMARY KEY (session_id, chunk_index);

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.file_revisions
    ADD CONSTRAINT uq_file_revisions_id_node UNIQUE (id, node_id);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);

ALTER TABLE ONLY public.user_grants
    ADD CONSTRAINT user_grants_grant_id_user_id_key UNIQUE (grant_id, user_id);

ALTER TABLE ONLY public.user_grants
    ADD CONSTRAINT user_grants_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY public.user_limits
    ADD CONSTRAINT user_limits_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_storage
    ADD CONSTRAINT user_storage_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX account_provider_account_idx ON public.account USING btree ("providerId", "accountId");

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");

CREATE INDEX idx_file_nodes_trash ON public.file_nodes USING btree (user_id, deleted_at DESC) WHERE (deleted_at IS NOT NULL);

CREATE INDEX idx_file_revisions_node ON public.file_revisions USING btree (node_id, created_at DESC);

CREATE INDEX idx_file_revisions_user_node ON public.file_revisions USING btree (user_id, node_id);

CREATE INDEX idx_grants_user_created ON public.grants USING btree (user_id, created_at, id);

CREATE INDEX idx_oauth_authz_codes_expires ON public.oauth_authorization_codes USING btree (expires_at) WHERE (used_at IS NULL);

CREATE INDEX idx_oauth_grants_client ON public.oauth_grants USING btree (oauth_client_id);

CREATE INDEX idx_refresh_tokens_grant ON public.refresh_tokens USING btree (grant_id);

CREATE INDEX idx_storage_tombstones_created_at ON public.storage_tombstones USING btree (created_at);

CREATE INDEX idx_upload_sessions_cleanup ON public.upload_sessions USING btree (expires_at) WHERE (status = ANY (ARRAY['active'::text, 'failed'::text]));

CREATE INDEX idx_upload_sessions_node ON public.upload_sessions USING btree (node_id);

CREATE INDEX idx_user_grants_user_parent ON public.user_grants USING btree (user_id, parent_grant_id) WHERE (parent_grant_id IS NOT NULL);

CREATE INDEX "passkey_credentialID_idx" ON public.passkey USING btree ("credentialID");

CREATE INDEX "passkey_userId_idx" ON public.passkey USING btree ("userId");

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");

CREATE INDEX "twoFactor_secret_idx" ON public."twoFactor" USING btree (secret);

CREATE INDEX "twoFactor_userId_idx" ON public."twoFactor" USING btree ("userId");

CREATE UNIQUE INDEX uniq_file_nodes_live_name ON public.file_nodes USING btree (user_id, parent_id, name) NULLS NOT DISTINCT WHERE (deleted_at IS NULL);

CREATE UNIQUE INDEX uq_oauth_grants_user_client ON public.oauth_grants USING btree (user_id, oauth_client_id);

CREATE UNIQUE INDEX uq_refresh_tokens_grant_active ON public.refresh_tokens USING btree (grant_id) WHERE ((used_at IS NULL) AND (revoked_at IS NULL));

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);

CREATE TRIGGER trg_file_revisions_tombstone AFTER DELETE ON public.file_revisions REFERENCING OLD TABLE AS deleted_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.enqueue_storage_tombstone();

CREATE TRIGGER trg_oauth_grants_cascade_grant AFTER DELETE ON public.oauth_grants FOR EACH ROW EXECUTE FUNCTION public.trg_oauth_grants_cascade_grant_fn();

ALTER TABLE ONLY public.access_tokens
    ADD CONSTRAINT access_tokens_grant_id_user_id_fkey FOREIGN KEY (grant_id, user_id) REFERENCES public.grants(id, user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.file_nodes
    ADD CONSTRAINT file_nodes_parent_user_fkey FOREIGN KEY (user_id, parent_id) REFERENCES public.file_nodes(user_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.file_nodes
    ADD CONSTRAINT file_nodes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.file_revisions
    ADD CONSTRAINT file_revisions_node_user_fkey FOREIGN KEY (user_id, node_id) REFERENCES public.file_nodes(user_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.file_nodes
    ADD CONSTRAINT fk_file_nodes_current_revision FOREIGN KEY (current_revision_id, id) REFERENCES public.file_revisions(id, node_id);

ALTER TABLE ONLY public.grant_paths
    ADD CONSTRAINT grant_paths_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES public.grants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.grants
    ADD CONSTRAINT grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_grant_id_user_id_fkey FOREIGN KEY (grant_id, user_id) REFERENCES public.grants(id, user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.oauth_grants
    ADD CONSTRAINT oauth_grants_oauth_client_id_fkey FOREIGN KEY (oauth_client_id) REFERENCES public.oauth_clients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_grant_id_user_id_fkey FOREIGN KEY (grant_id, user_id) REFERENCES public.grants(id, user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public."twoFactor"
    ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.upload_session_chunks
    ADD CONSTRAINT upload_session_chunks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.upload_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_node_id_fkey FOREIGN KEY (user_id, node_id) REFERENCES public.file_nodes(user_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_grants
    ADD CONSTRAINT user_grants_grant_id_user_id_fkey FOREIGN KEY (grant_id, user_id) REFERENCES public.grants(id, user_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_grants
    ADD CONSTRAINT user_grants_parent_grant_id_user_id_fkey FOREIGN KEY (parent_grant_id, user_id) REFERENCES public.user_grants(grant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.user_limits
    ADD CONSTRAINT user_limits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_storage
    ADD CONSTRAINT user_storage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

ALTER TABLE public.file_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY file_nodes_owner ON public.file_nodes USING ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text))) WITH CHECK ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text)));

ALTER TABLE public.file_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY file_revisions_owner ON public.file_revisions USING ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text))) WITH CHECK ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text)));

ALTER TABLE public.grant_paths ENABLE ROW LEVEL SECURITY;

CREATE POLICY grant_paths_owner ON public.grant_paths USING ((EXISTS ( SELECT 1
   FROM public.grants g
  WHERE (g.id = grant_paths.grant_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.grants g
  WHERE (g.id = grant_paths.grant_id))));

ALTER TABLE public.grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY grants_owner ON public.grants USING ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text))) WITH CHECK ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text)));

ALTER TABLE public.oauth_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_grants_owner ON public.oauth_grants USING ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text))) WITH CHECK ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text)));

ALTER TABLE public.upload_session_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY upload_session_chunks_owner ON public.upload_session_chunks USING ((EXISTS ( SELECT 1
   FROM public.upload_sessions s
  WHERE (s.id = upload_session_chunks.session_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.upload_sessions s
  WHERE (s.id = upload_session_chunks.session_id))));

ALTER TABLE public.upload_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY upload_sessions_owner ON public.upload_sessions USING ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text))) WITH CHECK ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text)));

ALTER TABLE public.user_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_grants_owner ON public.user_grants USING ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text))) WITH CHECK ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text)));

ALTER TABLE public.user_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_limits_owner ON public.user_limits USING ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text))) WITH CHECK ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text)));

ALTER TABLE public.user_storage ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_storage_owner ON public.user_storage USING ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text))) WITH CHECK ((user_id = NULLIF(current_setting('app.user_id'::text, true), ''::text)));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app;

-- migrate:down
-- Rollback is not supported. Drop the database and re-run migrations.

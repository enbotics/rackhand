-- Camera jobs remain durable Postgres rows. Supabase Realtime only notifies
-- connected listeners that a row changed; reconnecting consumers always read
-- the authoritative row again.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'CameraCaptureJob') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "public"."CameraCaptureJob";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'PutawayCaptureRequest') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "public"."PutawayCaptureRequest";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'AuditCaptureRequest') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "public"."AuditCaptureRequest";
  END IF;
END
$$;

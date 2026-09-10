-- Mirrors 20260909173000_enable_camera_realtime for the new table.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'RetrievalCaptureRequest') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "public"."RetrievalCaptureRequest";
  END IF;
END
$$;

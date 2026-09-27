begin;
-- Keep existing atomic replacement, ownership, and performance validation intact.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.replace_synced_holdings_data(uuid,jsonb,jsonb)'::regprocedure);
  if strpos(definition,'jsonb_array_length(snapshot) > 50') = 0 then
    raise exception 'holdings limit definition changed; review before applying';
  end if;
  definition := replace(definition,'jsonb_array_length(snapshot) > 50','jsonb_array_length(snapshot) > 200');
  definition := replace(definition,'holdings snapshot exceeds 50 rows','holdings snapshot exceeds 200 rows');
  execute definition;
end;
$$;
notify pgrst, 'reload schema';
commit;

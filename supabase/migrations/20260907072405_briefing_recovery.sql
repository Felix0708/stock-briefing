begin;

create table public.briefing_items (
  market text not null check (market in ('KR','US','JP')),
  rcept_no text not null,
  company text not null,
  stock_code text not null default '',
  filing jsonb not null,
  summary_html text not null,
  document_text text not null,
  ready boolean not null default false,
  created_at timestamptz not null default now(),
  primary key(market,rcept_no)
);
create index briefing_items_target on public.briefing_items(market,company,created_at);
alter table public.briefing_items enable row level security;
revoke all on public.briefing_items from public,anon,authenticated;
grant select,insert,update,delete on public.briefing_items to service_role;

create table public.briefing_mail_batches (
  id uuid primary key default gen_random_uuid(),
  recipient_key text not null check(recipient_key ~ '^[a-f0-9]{64}$'),
  user_id uuid references auth.users(id) on delete cascade,
  state text not null default 'prepared' check(state in ('prepared','sending','sent','failed','uncertain')),
  items jsonb not null,
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  sent_at timestamptz
);
create index briefing_mail_pending on public.briefing_mail_batches(recipient_key,created_at) where state<>'sent';
create index briefing_mail_owner on public.briefing_mail_batches(user_id) where user_id is not null;
alter table public.briefing_mail_batches enable row level security;
revoke all on public.briefing_mail_batches from public,anon,authenticated;
grant select,insert,update,delete on public.briefing_mail_batches to service_role;

create table public.briefing_mail_receipts (
  recipient_key text not null,
  market text not null,
  rcept_no text not null,
  batch_id uuid not null references public.briefing_mail_batches(id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key(recipient_key,market,rcept_no)
);
create index briefing_receipts_batch on public.briefing_mail_receipts(batch_id);
alter table public.briefing_mail_receipts enable row level security;
revoke all on public.briefing_mail_receipts from public,anon,authenticated;
grant select,insert,update,delete on public.briefing_mail_receipts to service_role;

create function public.prepare_briefing_batch(recipient text, member_id uuid, candidates jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare existing public.briefing_mail_batches%rowtype; selected jsonb;
begin
  if recipient !~ '^[a-f0-9]{64}$' or jsonb_typeof(candidates)<>'array' then raise exception 'Invalid batch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(recipient,17));
  select * into existing from public.briefing_mail_batches
    where recipient_key=recipient and state<>'sent' order by created_at limit 1 for update;
  if found then return to_jsonb(existing); end if;
  select jsonb_agg(to_jsonb(i) - 'document_text' order by i.created_at,i.rcept_no) into selected
    from public.briefing_items i
    where i.ready and exists(select 1 from jsonb_array_elements(candidates) c
      where c->>'market'=i.market and c->>'rcept_no'=i.rcept_no)
    and not exists(select 1 from public.briefing_mail_receipts r
      where r.recipient_key=recipient and r.market=i.market and r.rcept_no=i.rcept_no);
  if selected is null then return null; end if;
  insert into public.briefing_mail_batches(recipient_key,user_id,items)
    values(recipient,member_id,selected) returning * into existing;
  return to_jsonb(existing);
end;
$$;

create function public.start_briefing_batch(batch_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.briefing_mail_batches set state='sending',attempted_at=now()
    where id=batch_id and state in ('prepared','failed');
  return found;
end;
$$;

create function public.retry_briefing_batch(batch_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  -- A second recovery worker must not reset a newly claimed SMTP attempt.
  update public.briefing_mail_batches set state='failed'
    where id=batch_id and state in ('sending','uncertain') and attempted_at<now()-interval '15 minutes';
  return found;
end;
$$;
revoke all on function public.retry_briefing_batch(uuid) from public,anon,authenticated;
grant execute on function public.retry_briefing_batch(uuid) to service_role;

create function public.finish_briefing_batch(batch_id uuid, outcome text)
returns void language plpgsql security invoker set search_path='' as $$
declare batch public.briefing_mail_batches%rowtype;
begin
  if outcome not in ('sent','failed','uncertain') then raise exception 'Invalid outcome'; end if;
  select * into batch from public.briefing_mail_batches where id=batch_id for update;
  if not found then raise exception 'Unknown batch'; end if;
  if batch.state='sent' then return; end if;
  if outcome='sent' then
    insert into public.briefing_mail_receipts(recipient_key,market,rcept_no,batch_id)
      select batch.recipient_key,x->>'market',x->>'rcept_no',batch.id from jsonb_array_elements(batch.items) x
      on conflict(recipient_key,market,rcept_no) do nothing;
  end if;
  update public.briefing_mail_batches set state=outcome,sent_at=case when outcome='sent' then now() end where id=batch_id;
end;
$$;
revoke all on function public.prepare_briefing_batch(text,uuid,jsonb),public.start_briefing_batch(uuid),public.finish_briefing_batch(uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_briefing_batch(text,uuid,jsonb),public.start_briefing_batch(uuid),public.finish_briefing_batch(uuid,text) to service_role;

alter table public.briefing_deliveries drop constraint briefing_deliveries_status_check;
alter table public.briefing_deliveries add constraint briefing_deliveries_status_check
  check(status in ('sent','no_filings','collection_failed','failed','disabled','limit_reached','uncertain','already_sent'));
notify pgrst,'reload schema';
commit;

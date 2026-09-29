-- Brand Slogan -> Logo multiplayer quiz
-- Run this FIRST in Supabase SQL Editor.
-- Then run private/quiz-data.sql from your local copy (that file is gitignored).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.quiz_rounds (
  round_number integer primary key,
  brand text not null,
  slogan text not null,
  aliases text[] not null,
  note text,
  question_image text not null,
  answer_image text not null,
  correct_side text not null check (correct_side in ('left','right'))
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_id uuid not null references auth.users(id) on delete cascade,
  phase text not null default 'lobby' check (phase in (
    'lobby','slogan','slogan_reveal','logo_wait','logo_active','logo_reveal','finished'
  )),
  round_order integer[] not null default '{}'::integer[],
  current_round_pos integer not null default 0,
  logo_deadline timestamptz,
  logo_duration_seconds integer not null default 10 check (logo_duration_seconds between 3 and 60),
  lobby_locked boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 30),
  active boolean not null default true,
  joined_at timestamptz not null default clock_timestamp(),
  unique (game_id, user_id)
);

create unique index if not exists players_unique_active_name
  on public.players (game_id, lower(display_name))
  where active;

create index if not exists players_game_id_idx on public.players(game_id);
create index if not exists players_user_id_idx on public.players(user_id);

create table if not exists public.answers (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  round_number integer not null,
  slogan_answer text,
  slogan_correct boolean,
  slogan_submitted_at timestamptz,
  logo_answer text check (logo_answer is null or logo_answer in ('left','right')),
  logo_correct boolean,
  logo_submitted_at timestamptz,
  unique (game_id, player_id, round_number)
);

create index if not exists answers_game_round_idx on public.answers(game_id, round_number);
create index if not exists answers_player_idx on public.answers(player_id);

alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.answers enable row level security;

revoke all on public.games from anon, authenticated;
revoke all on public.players from anon, authenticated;
revoke all on public.answers from anon, authenticated;
grant select on public.games to authenticated;

create or replace function public.is_game_member(p_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.players p
    where p.game_id = p_game_id
      and p.user_id = auth.uid()
      and p.active
  );
$$;

revoke all on function public.is_game_member(uuid) from public;
grant execute on function public.is_game_member(uuid) to authenticated;

drop policy if exists games_member_select on public.games;
create policy games_member_select
on public.games
for select
to authenticated
using (host_id = (select auth.uid()) or public.is_game_member(id));

-- No direct table policies are provided for players/answers. All reads and writes go through RPCs.

create or replace function private.normalize_answer(p_text text)
returns text
language sql
immutable
set search_path = private, extensions
as $$
  select regexp_replace(
    extensions.unaccent(lower(coalesce(p_text,''))),
    '[^a-z0-9]+',
    '',
    'g'
  );
$$;

create or replace function private.current_round_number(p_game public.games)
returns integer
language sql
stable
set search_path = public, private
as $$
  select case
    when p_game.current_round_pos > 0
     and p_game.current_round_pos <= coalesce(array_length(p_game.round_order,1),0)
    then p_game.round_order[p_game.current_round_pos]
    else null
  end;
$$;

create or replace function private.require_host(p_game_id uuid)
returns public.games
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_game public.games;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_game
  from public.games
  where id = p_game_id
    and host_id = auth.uid();

  if not found then
    raise exception 'Host access required';
  end if;

  return v_game;
end;
$$;

create or replace function private.generate_game_code()
returns text
language plpgsql
volatile
set search_path = public, private
as $$
declare
  chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i integer;
begin
  loop
    candidate := '';
    for i in 1..6 loop
      candidate := candidate || substr(chars, 1 + floor(random() * length(chars))::integer, 1);
    end loop;
    exit when not exists (select 1 from public.games where code = candidate);
  end loop;
  return candidate;
end;
$$;

create or replace function private.player_scoreboard(
  p_game_id uuid,
  p_current_round integer,
  p_phase text,
  p_host_view boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path = public, private
as $$
  select coalesce(jsonb_agg(row_json order by total_score desc, slogan_score desc, display_name), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'player_id', p.id,
      'name', p.display_name,
      'slogan_score', coalesce(sum(
        case when a.slogan_correct is true and (
          p_host_view
          or a.round_number <> p_current_round
          or p_phase in ('slogan_reveal','logo_wait','logo_active','logo_reveal','finished')
        ) then 1 else 0 end
      ),0)::integer,
      'logo_score', coalesce(sum(
        case when a.logo_correct is true and (
          p_host_view
          or a.round_number <> p_current_round
          or p_phase in ('logo_reveal','finished')
        ) then 1 else 0 end
      ),0)::integer,
      'total_score', coalesce(sum(
        case when a.slogan_correct is true and (
          p_host_view
          or a.round_number <> p_current_round
          or p_phase in ('slogan_reveal','logo_wait','logo_active','logo_reveal','finished')
        ) then 1 else 0 end
        +
        case when a.logo_correct is true and (
          p_host_view
          or a.round_number <> p_current_round
          or p_phase in ('logo_reveal','finished')
        ) then 1 else 0 end
      ),0)::integer
    ) as row_json,
    p.display_name,
    coalesce(sum(case when a.slogan_correct is true and (
      p_host_view or a.round_number <> p_current_round
      or p_phase in ('slogan_reveal','logo_wait','logo_active','logo_reveal','finished')
    ) then 1 else 0 end),0)::integer as slogan_score,
    coalesce(sum(
      case when a.slogan_correct is true and (
        p_host_view or a.round_number <> p_current_round
        or p_phase in ('slogan_reveal','logo_wait','logo_active','logo_reveal','finished')
      ) then 1 else 0 end
      + case when a.logo_correct is true and (
        p_host_view or a.round_number <> p_current_round
        or p_phase in ('logo_reveal','finished')
      ) then 1 else 0 end
    ),0)::integer as total_score
    from public.players p
    left join public.answers a on a.player_id = p.id and a.game_id = p_game_id
    where p.game_id = p_game_id and p.active
    group by p.id, p.display_name
  ) s;
$$;

create or replace function public.create_game(p_logo_duration_seconds integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_game public.games;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if coalesce((select is_anonymous from auth.users where id = auth.uid()), true) then
    raise exception 'A permanent host account is required';
  end if;

  if p_logo_duration_seconds < 3 or p_logo_duration_seconds > 60 then
    raise exception 'Timer must be between 3 and 60 seconds';
  end if;

  insert into public.games(code, host_id, logo_duration_seconds)
  values (private.generate_game_code(), auth.uid(), p_logo_duration_seconds)
  returning * into v_game;

  return jsonb_build_object('id',v_game.id,'code',v_game.code,'phase',v_game.phase);
end;
$$;

create or replace function public.get_my_active_game()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_game
  from public.games
  where host_id = auth.uid() and phase <> 'finished'
  order by created_at desc
  limit 1;

  if not found then return null; end if;
  return jsonb_build_object('id',v_game.id,'code',v_game.code,'phase',v_game.phase);
end;
$$;

create or replace function public.join_game(p_game_code text, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games;
  v_player public.players;
  v_name text := regexp_replace(trim(coalesce(p_display_name,'')), '\\s+', ' ', 'g');
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(v_name) < 2 or char_length(v_name) > 30 then
    raise exception 'Name must be between 2 and 30 characters';
  end if;

  select * into v_game
  from public.games
  where code = upper(trim(p_game_code));

  if not found then raise exception 'Game code not found'; end if;

  select * into v_player
  from public.players
  where game_id = v_game.id and user_id = auth.uid();

  if found then
    if not v_player.active then raise exception 'You were removed from this game'; end if;
    return jsonb_build_object('game_id',v_game.id,'player_id',v_player.id,'code',v_game.code);
  end if;

  if v_game.phase <> 'lobby' or v_game.lobby_locked then
    raise exception 'This game has already started';
  end if;

  begin
    insert into public.players(game_id,user_id,display_name)
    values (v_game.id,auth.uid(),v_name)
    returning * into v_player;
  exception when unique_violation then
    raise exception 'That display name is already in use';
  end;

  update public.games set updated_at = clock_timestamp() where id = v_game.id;

  return jsonb_build_object('game_id',v_game.id,'player_id',v_player.id,'code',v_game.code);
end;
$$;

create or replace function public.submit_slogan(p_game_code text, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_game public.games;
  v_player public.players;
  v_round integer;
  v_correct boolean;
  v_existing public.answers;
  v_answer text := left(trim(coalesce(p_answer,'')),100);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if v_answer = '' then raise exception 'Enter an answer before submitting'; end if;

  select * into v_game from public.games where code = upper(trim(p_game_code));
  if not found then raise exception 'Game not found'; end if;
  if v_game.phase <> 'slogan' then raise exception 'Brand answers are closed'; end if;

  select * into v_player from public.players
  where game_id=v_game.id and user_id=auth.uid() and active;
  if not found then raise exception 'You are not an active player in this game'; end if;

  v_round := private.current_round_number(v_game);
  select * into v_existing from public.answers
  where game_id=v_game.id and player_id=v_player.id and round_number=v_round;
  if found and v_existing.slogan_submitted_at is not null then
    raise exception 'Your brand answer is already locked';
  end if;

  select exists(
    select 1
    from private.quiz_rounds q, unnest(q.aliases) a(alias)
    where q.round_number=v_round
      and private.normalize_answer(a.alias)=private.normalize_answer(v_answer)
  ) into v_correct;

  insert into public.answers(game_id,player_id,round_number,slogan_answer,slogan_correct,slogan_submitted_at)
  values(v_game.id,v_player.id,v_round,v_answer,v_correct,clock_timestamp())
  on conflict (game_id,player_id,round_number)
  do update set slogan_answer=excluded.slogan_answer,
                slogan_correct=excluded.slogan_correct,
                slogan_submitted_at=excluded.slogan_submitted_at;

  update public.games set updated_at=clock_timestamp() where id=v_game.id;
  return jsonb_build_object('accepted',true);
end;
$$;

create or replace function public.submit_logo(p_game_code text, p_side text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_game public.games;
  v_player public.players;
  v_round integer;
  v_correct boolean;
  v_side text := lower(trim(coalesce(p_side,'')));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if v_side not in ('left','right') then raise exception 'Choose left or right'; end if;

  select * into v_game from public.games where code=upper(trim(p_game_code));
  if not found then raise exception 'Game not found'; end if;
  if v_game.phase <> 'logo_active' then raise exception 'The logo timer is not active'; end if;
  if v_game.logo_deadline is null or clock_timestamp() >= v_game.logo_deadline then
    raise exception 'Time is up';
  end if;

  select * into v_player from public.players
  where game_id=v_game.id and user_id=auth.uid() and active;
  if not found then raise exception 'You are not an active player in this game'; end if;

  v_round := private.current_round_number(v_game);
  select (q.correct_side=v_side) into v_correct
  from private.quiz_rounds q where q.round_number=v_round;

  insert into public.answers(game_id,player_id,round_number,logo_answer,logo_correct,logo_submitted_at)
  values(v_game.id,v_player.id,v_round,v_side,v_correct,clock_timestamp())
  on conflict (game_id,player_id,round_number)
  do update set logo_answer=excluded.logo_answer,
                logo_correct=excluded.logo_correct,
                logo_submitted_at=excluded.logo_submitted_at;

  update public.games set updated_at=clock_timestamp() where id=v_game.id;
  return jsonb_build_object('accepted',true,'side',v_side);
end;
$$;

create or replace function public.get_player_state(p_game_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_game public.games;
  v_player public.players;
  v_round integer;
  v_quiz private.quiz_rounds;
  v_answer public.answers;
  v_player_count integer;
  v_slogan_submitted integer;
  v_logo_submitted integer;
  v_show_brand boolean;
  v_show_question boolean;
  v_show_logo_answer boolean;
  v_slogan_correct_players jsonb := '[]'::jsonb;
  v_logo_correct_players jsonb := '[]'::jsonb;
  v_leaderboard jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_game from public.games where code=upper(trim(p_game_code));
  if not found then raise exception 'Game not found'; end if;

  select * into v_player from public.players
  where game_id=v_game.id and user_id=auth.uid() and active;
  if not found then raise exception 'You have not joined this game'; end if;

  select count(*) into v_player_count from public.players where game_id=v_game.id and active;
  v_round := private.current_round_number(v_game);

  if v_round is not null then
    select * into v_quiz from private.quiz_rounds where round_number=v_round;
    select * into v_answer from public.answers
      where game_id=v_game.id and player_id=v_player.id and round_number=v_round;
    select count(*) into v_slogan_submitted from public.answers
      where game_id=v_game.id and round_number=v_round and slogan_submitted_at is not null;
    select count(*) into v_logo_submitted from public.answers
      where game_id=v_game.id and round_number=v_round and logo_submitted_at is not null;
  else
    v_slogan_submitted := 0;
    v_logo_submitted := 0;
  end if;

  v_show_brand := v_game.phase in ('slogan_reveal','logo_wait','logo_active','logo_reveal','finished');
  v_show_question := v_game.phase in ('logo_wait','logo_active','logo_reveal','finished');
  v_show_logo_answer := v_game.phase in ('logo_reveal','finished');

  if v_round is not null and v_show_brand then
    select coalesce(jsonb_agg(p.display_name order by p.display_name),'[]'::jsonb)
    into v_slogan_correct_players
    from public.answers a join public.players p on p.id=a.player_id
    where a.game_id=v_game.id and a.round_number=v_round and p.active and a.slogan_correct is true;
  end if;

  if v_round is not null and v_show_logo_answer then
    select coalesce(jsonb_agg(p.display_name order by p.display_name),'[]'::jsonb)
    into v_logo_correct_players
    from public.answers a join public.players p on p.id=a.player_id
    where a.game_id=v_game.id and a.round_number=v_round and p.active and a.logo_correct is true;
  end if;

  v_leaderboard := private.player_scoreboard(v_game.id,v_round,v_game.phase,false);

  return jsonb_build_object(
    'server_now', clock_timestamp(),
    'game', jsonb_build_object(
      'id',v_game.id,'code',v_game.code,'phase',v_game.phase,
      'round_position',v_game.current_round_pos,
      'total_rounds',coalesce(array_length(v_game.round_order,1),37),
      'logo_deadline',v_game.logo_deadline,
      'logo_duration_seconds',v_game.logo_duration_seconds,
      'player_count',v_player_count,
      'slogan_submitted_count',v_slogan_submitted,
      'logo_submitted_count',v_logo_submitted
    ),
    'player', jsonb_build_object('id',v_player.id,'name',v_player.display_name),
    'round', case when v_round is null then null else jsonb_build_object(
      'round_number',v_round,
      'slogan',v_quiz.slogan,
      'brand',case when v_show_brand then v_quiz.brand else null end,
      'question_image',case when v_show_question then v_quiz.question_image else null end,
      'answer_image',case when v_show_logo_answer then v_quiz.answer_image else null end,
      'note',case when v_show_logo_answer then v_quiz.note else null end
    ) end,
    'my_answer', case when v_round is null or v_answer.id is null then null else jsonb_build_object(
      'slogan_answer',v_answer.slogan_answer,
      'slogan_submitted',v_answer.slogan_submitted_at is not null,
      'slogan_correct',case when v_show_brand then v_answer.slogan_correct else null end,
      'logo_answer',v_answer.logo_answer,
      'logo_submitted',v_answer.logo_submitted_at is not null,
      'logo_correct',case when v_show_logo_answer then v_answer.logo_correct else null end
    ) end,
    'slogan_correct_players',v_slogan_correct_players,
    'logo_correct_players',v_logo_correct_players,
    'leaderboard',v_leaderboard
  );
end;
$$;

create or replace function public.get_host_state(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_game public.games;
  v_round integer;
  v_quiz private.quiz_rounds;
  v_players jsonb := '[]'::jsonb;
  v_player_count integer;
  v_slogan_submitted integer := 0;
  v_logo_submitted integer := 0;
  v_leaderboard jsonb := '[]'::jsonb;
begin
  v_game := private.require_host(p_game_id);
  v_round := private.current_round_number(v_game);

  if v_round is not null then
    select * into v_quiz from private.quiz_rounds where round_number=v_round;
    select count(*) into v_slogan_submitted from public.answers
      where game_id=v_game.id and round_number=v_round and slogan_submitted_at is not null;
    select count(*) into v_logo_submitted from public.answers
      where game_id=v_game.id and round_number=v_round and logo_submitted_at is not null;
  end if;

  select count(*) into v_player_count from public.players where game_id=v_game.id and active;

  select coalesce(jsonb_agg(x order by (x->>'total_score')::integer desc, x->>'name'),'[]'::jsonb)
  into v_players
  from (
    select jsonb_build_object(
      'id',p.id,
      'name',p.display_name,
      'joined_at',p.joined_at,
      'slogan_answer',a.slogan_answer,
      'slogan_correct',a.slogan_correct,
      'slogan_submitted',a.slogan_submitted_at is not null,
      'logo_answer',a.logo_answer,
      'logo_correct',a.logo_correct,
      'logo_submitted',a.logo_submitted_at is not null,
      'slogan_score',(select count(*) from public.answers s where s.player_id=p.id and s.slogan_correct is true),
      'logo_score',(select count(*) from public.answers l where l.player_id=p.id and l.logo_correct is true),
      'total_score',(select count(*) from public.answers z where z.player_id=p.id and z.slogan_correct is true)
                    +(select count(*) from public.answers z where z.player_id=p.id and z.logo_correct is true)
    ) x
    from public.players p
    left join public.answers a
      on a.player_id=p.id and a.game_id=v_game.id and a.round_number=v_round
    where p.game_id=v_game.id and p.active
  ) q;

  v_leaderboard := private.player_scoreboard(v_game.id,v_round,v_game.phase,true);

  return jsonb_build_object(
    'server_now',clock_timestamp(),
    'game',jsonb_build_object(
      'id',v_game.id,'code',v_game.code,'phase',v_game.phase,
      'round_position',v_game.current_round_pos,
      'total_rounds',coalesce(array_length(v_game.round_order,1),37),
      'logo_deadline',v_game.logo_deadline,
      'logo_duration_seconds',v_game.logo_duration_seconds,
      'lobby_locked',v_game.lobby_locked,
      'player_count',v_player_count,
      'slogan_submitted_count',v_slogan_submitted,
      'logo_submitted_count',v_logo_submitted
    ),
    'round',case when v_round is null then null else jsonb_build_object(
      'round_number',v_round,'brand',v_quiz.brand,'slogan',v_quiz.slogan,
      'question_image',v_quiz.question_image,'answer_image',v_quiz.answer_image,
      'correct_side',v_quiz.correct_side,'note',v_quiz.note
    ) end,
    'players',v_players,
    'leaderboard',v_leaderboard
  );
end;
$$;

create or replace function public.start_game(p_game_id uuid, p_shuffle boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_game public.games;
  v_order integer[];
  v_count integer;
begin
  v_game := private.require_host(p_game_id);
  if v_game.phase <> 'lobby' then raise exception 'Game has already started'; end if;
  select count(*) into v_count from public.players where game_id=p_game_id and active;
  if v_count < 1 then raise exception 'At least one player must join before starting'; end if;

  if p_shuffle then
    select array_agg(round_number order by random()) into v_order from private.quiz_rounds;
  else
    select array_agg(round_number order by round_number) into v_order from private.quiz_rounds;
  end if;

  if coalesce(array_length(v_order,1),0) = 0 then
    raise exception 'Quiz data is missing. Run private/quiz-data.sql in Supabase.';
  end if;

  update public.games
  set phase='slogan',round_order=v_order,current_round_pos=1,
      lobby_locked=true,logo_deadline=null,updated_at=clock_timestamp()
  where id=p_game_id;

  return public.get_host_state(p_game_id);
end;
$$;

create or replace function public.reveal_slogan(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_game public.games;
begin
  v_game := private.require_host(p_game_id);
  if v_game.phase <> 'slogan' then raise exception 'Slogan reveal is not available now'; end if;
  update public.games set phase='slogan_reveal',updated_at=clock_timestamp() where id=p_game_id;
  return public.get_host_state(p_game_id);
end;
$$;

create or replace function public.open_logo_challenge(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_game public.games;
begin
  v_game := private.require_host(p_game_id);
  if v_game.phase <> 'slogan_reveal' then raise exception 'Reveal the brand first'; end if;
  update public.games set phase='logo_wait',logo_deadline=null,updated_at=clock_timestamp() where id=p_game_id;
  return public.get_host_state(p_game_id);
end;
$$;

create or replace function public.start_logo_timer(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_game public.games;
begin
  v_game := private.require_host(p_game_id);
  if v_game.phase <> 'logo_wait' then raise exception 'Open the logo challenge first'; end if;
  update public.games
  set phase='logo_active',logo_deadline=clock_timestamp() + make_interval(secs => v_game.logo_duration_seconds),updated_at=clock_timestamp()
  where id=p_game_id;
  return public.get_host_state(p_game_id);
end;
$$;

create or replace function public.reveal_logo(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_game public.games;
begin
  v_game := private.require_host(p_game_id);
  if v_game.phase <> 'logo_active' then raise exception 'The logo timer has not run'; end if;
  if v_game.logo_deadline is null or clock_timestamp() < v_game.logo_deadline then
    raise exception 'Wait until the logo timer reaches zero';
  end if;
  update public.games set phase='logo_reveal',updated_at=clock_timestamp() where id=p_game_id;
  return public.get_host_state(p_game_id);
end;
$$;

create or replace function public.next_round(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_game public.games;
begin
  v_game := private.require_host(p_game_id);
  if v_game.phase <> 'logo_reveal' then raise exception 'Reveal the correct logo first'; end if;

  if v_game.current_round_pos >= coalesce(array_length(v_game.round_order,1),0) then
    update public.games set phase='finished',logo_deadline=null,updated_at=clock_timestamp() where id=p_game_id;
  else
    update public.games
      set phase='slogan',current_round_pos=current_round_pos+1,logo_deadline=null,updated_at=clock_timestamp()
      where id=p_game_id;
  end if;
  return public.get_host_state(p_game_id);
end;
$$;

create or replace function public.end_game(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
begin
  perform private.require_host(p_game_id);
  update public.games set phase='finished',logo_deadline=null,lobby_locked=true,updated_at=clock_timestamp() where id=p_game_id;
  return public.get_host_state(p_game_id);
end;
$$;

create or replace function public.remove_player(p_game_id uuid, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_game public.games;
begin
  v_game := private.require_host(p_game_id);
  if v_game.phase <> 'lobby' then raise exception 'Players can only be removed while in the lobby'; end if;
  update public.players set active=false where id=p_player_id and game_id=p_game_id;
  update public.games set updated_at=clock_timestamp() where id=p_game_id;
  return public.get_host_state(p_game_id);
end;
$$;

-- Lock RPC execution to signed-in Supabase users. Anonymous players use Supabase anonymous Auth,
-- which still gives them an authenticated JWT role.
revoke execute on function public.create_game(integer) from public, anon;
revoke execute on function public.get_my_active_game() from public, anon;
revoke execute on function public.join_game(text,text) from public, anon;
revoke execute on function public.submit_slogan(text,text) from public, anon;
revoke execute on function public.submit_logo(text,text) from public, anon;
revoke execute on function public.get_player_state(text) from public, anon;
revoke execute on function public.get_host_state(uuid) from public, anon;
revoke execute on function public.start_game(uuid,boolean) from public, anon;
revoke execute on function public.reveal_slogan(uuid) from public, anon;
revoke execute on function public.open_logo_challenge(uuid) from public, anon;
revoke execute on function public.start_logo_timer(uuid) from public, anon;
revoke execute on function public.reveal_logo(uuid) from public, anon;
revoke execute on function public.next_round(uuid) from public, anon;
revoke execute on function public.end_game(uuid) from public, anon;
revoke execute on function public.remove_player(uuid,uuid) from public, anon;

grant execute on function public.create_game(integer) to authenticated;
grant execute on function public.get_my_active_game() to authenticated;
grant execute on function public.join_game(text,text) to authenticated;
grant execute on function public.submit_slogan(text,text) to authenticated;
grant execute on function public.submit_logo(text,text) to authenticated;
grant execute on function public.get_player_state(text) to authenticated;
grant execute on function public.get_host_state(uuid) to authenticated;
grant execute on function public.start_game(uuid,boolean) to authenticated;
grant execute on function public.reveal_slogan(uuid) to authenticated;
grant execute on function public.open_logo_challenge(uuid) to authenticated;
grant execute on function public.start_logo_timer(uuid) to authenticated;
grant execute on function public.reveal_logo(uuid) to authenticated;
grant execute on function public.next_round(uuid) to authenticated;
grant execute on function public.end_game(uuid) to authenticated;
grant execute on function public.remove_player(uuid,uuid) to authenticated;

-- Realtime invalidation: clients subscribe only to the game row and call the appropriate RPC to refresh.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='games'
  ) then
    alter publication supabase_realtime add table public.games;
  end if;
end $$;

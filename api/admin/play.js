// ===== 管理员 - 广场内容管理 =====
//
// 重写要点：
//   · 作者邮箱不再取自会过期的 email-map.json，取自 Supabase Auth Admin API
//   · 搜索作者昵称/邮箱时先把候选集拉回来再内存过滤，不再「只对当前页过滤」
//   · 所有 delete / count 都检查 error（旧实现整段忽略错误，删失败也返回成功）
//   · 分页、错误响应与其它 admin 接口统一

import { jsonResp } from '../utils/response.js';
import { makeSupabase } from '../utils/supabase.js';
import { checkRateLimit } from '../utils/rate-limit.js';
import {
  requireAdmin, requireWriteAdmin, pager, cleanSearch, pagePayload,
  getUserBriefs,
} from '../utils/admin-data.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEARCH_SCAN = 500;   // 搜索模式下的最大候选集，避免内存无界

async function profileMap(supabase, env, ids) {
  const map = new Map();
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return map;

  // 只查「当前页这几位作者」，不再为补邮箱而全量拉 Auth 用户
  const [{ data: profiles }, authIndex] = await Promise.all([
    supabase.from('gh_play_profile').select('id, nickname, avatar_url, bio').in('id', uniq),
    getUserBriefs(supabase, uniq),
  ]);

  for (const p of (profiles || [])) {
    const a = authIndex.get(p.id);
    map.set(p.id, {
      id: p.id,
      nickname: p.nickname || '',
      accountName: a?.name || '',
      email: a?.email || '',
      avatar_url: p.avatar_url || '',
    });
  }
  for (const id of uniq) {
    if (map.has(id)) continue;
    const a = authIndex.get(id);
    map.set(id, { id, nickname: '', accountName: a?.name || '', email: a?.email || '', avatar_url: '' });
  }
  return map;
}

function matchesAuthor(author, lower) {
  return (author?.nickname || '').toLowerCase().includes(lower) ||
    (author?.accountName || '').toLowerCase().includes(lower) ||
    (author?.email || '').toLowerCase().includes(lower);
}

function safeCount(promise, label) {
  return promise.then(({ count, error }) => {
    if (error) console.error(`[admin-play-stats] ${label}:`, error.message);
    return count || 0;
  }).catch(err => {
    console.error(`[admin-play-stats] ${label} exception:`, err.message);
    return 0;
  });
}

export async function handleAdminPlayPosts(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  const sp = new URL(request.url).searchParams;
  const { limit, offset, page } = pager(sp, { defLimit: 25, maxLimit: 100 });
  const kind = sp.get('kind') || '';
  const q = cleanSearch(sp.get('q'), 60);
  const lower = q.toLowerCase();

  try {
    const supabase = makeSupabase(env);
    const cols = 'id, author_id, kind, title, content, site_slug, site_url, preview_status, like_count, comment_count, view_count, created_at';

    let base = supabase.from('gh_play_post').select(cols, q ? undefined : { count: 'exact' });
    if (kind === 'site' || kind === 'text') base = base.eq('kind', kind);
    if (q) base = base.or(`title.ilike.%${q}%,content.ilike.%${q}%`);

    let rows, total, countFromServer;
    if (q) {
      // 搜索作者时必须在候选集内做内存过滤，不能只过滤当前页
      const { data, error } = await base.order('created_at', { ascending: false }).range(0, SEARCH_SCAN - 1);
      if (error) throw error;
      rows = data || [];
    } else {
      const { data, error, count } = await base.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (error) throw error;
      rows = data || [];
      countFromServer = count || 0;
    }

    const authors = await profileMap(supabase, env, rows.map(p => p.author_id));
    let posts = rows.map(p => ({
      ...p,
      author: authors.get(p.author_id) || { id: p.author_id, nickname: '', accountName: '', email: '', avatar_url: '' },
    }));

    if (q) {
      posts = posts.filter(p =>
        (p.title || '').toLowerCase().includes(lower) ||
        (p.content || '').toLowerCase().includes(lower) ||
        matchesAuthor(p.author, lower)
      );
      total = posts.length;
      posts = posts.slice(offset, offset + limit);
    } else {
      total = countFromServer;
    }

    return jsonResp({
      posts,
      pagination: pagePayload({ page, limit, offset }, total, posts.length),
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-play-posts] failed:', err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}

export async function handleAdminPlayComments(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  const sp = new URL(request.url).searchParams;
  const { limit, offset, page } = pager(sp, { defLimit: 25, maxLimit: 100 });
  const postId = sp.get('post_id') || '';
  const q = cleanSearch(sp.get('q'), 60);
  const lower = q.toLowerCase();

  try {
    const supabase = makeSupabase(env);
    const cols = 'id, post_id, author_id, parent_id, depth, content, is_ai, mention_ai, created_at';

    let base = supabase.from('gh_play_comment').select(cols, q ? undefined : { count: 'exact' });
    if (postId && ID_RE.test(postId)) base = base.eq('post_id', postId);
    if (q) base = base.ilike('content', `%${q}%`);

    let rows, total;
    if (q) {
      const { data, error } = await base.order('created_at', { ascending: false }).range(0, SEARCH_SCAN - 1);
      if (error) throw error;
      rows = data || [];
    } else {
      const { data, error, count } = await base.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (error) throw error;
      rows = data || [];
      total = count || 0;
    }

    const authors = await profileMap(supabase, env, rows.map(c => c.author_id));
    const postIds = [...new Set(rows.map(c => c.post_id).filter(Boolean))];
    let postTitles = new Map();
    if (postIds.length) {
      const { data: posts, error } = await supabase
        .from('gh_play_post').select('id, title').in('id', postIds);
      if (error) throw error;
      postTitles = new Map((posts || []).map(p => [p.id, p.title]));
    }

    let comments = rows.map(c => ({
      ...c,
      post_title: postTitles.get(c.post_id) || '',
      author: c.is_ai
        ? { id: null, nickname: '小鹅C', accountName: '', email: '', avatar_url: '', is_ai: true }
        : (authors.get(c.author_id) || { id: c.author_id, nickname: '', accountName: '', email: '', avatar_url: '' }),
    }));

    if (q) {
      comments = comments.filter(c =>
        (c.content || '').toLowerCase().includes(lower) ||
        (c.post_title || '').toLowerCase().includes(lower) ||
        matchesAuthor(c.author, lower)
      );
      total = comments.length;
      comments = comments.slice(offset, offset + limit);
    }

    return jsonResp({
      comments,
      pagination: pagePayload({ page, limit, offset }, total, comments.length),
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-play-comments] failed:', err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}

// GET /api/admin/play/post/:id - 帖子详情（含评论），供后台弹窗钻取
export async function handleAdminPlayPostDetail(request, env, corsHeaders, postId) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  if (!postId || !ID_RE.test(postId)) {
    return jsonResp({ error: '无效的帖子ID' }, 400, corsHeaders);
  }

  try {
    const supabase = makeSupabase(env);
    const { data: post, error } = await supabase
      .from('gh_play_post')
      .select('id, author_id, kind, title, content, site_slug, site_url, preview_status, like_count, comment_count, view_count, created_at')
      .eq('id', postId)
      .maybeSingle();
    if (error) throw error;
    if (!post) return jsonResp({ error: '帖子不存在' }, 404, corsHeaders);

    const { data: comments, error: cErr } = await supabase
      .from('gh_play_comment')
      .select('id, author_id, content, is_ai, created_at')
      .eq('post_id', postId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (cErr) throw cErr;

    const ids = [post.author_id, ...(comments || []).map(c => c.author_id)].filter(Boolean);
    const authors = await profileMap(supabase, env, ids);
    const decorate = (c) => ({
      ...c,
      author: c.is_ai
        ? { nickname: '小鹅C', email: '', is_ai: true }
        : (authors.get(c.author_id) || { nickname: '', email: '' }),
    });

    return jsonResp({
      post: {
        ...post,
        author: authors.get(post.author_id) || { nickname: '', email: '' },
      },
      comments: (comments || []).map(decorate),
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-play-post-detail] failed:', postId, err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}

export async function handleAdminDeletePlayPost(request, env, corsHeaders, postId) {
  const denied = await requireWriteAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  if (!postId || !ID_RE.test(postId)) {
    return jsonResp({ error: '无效的帖子ID' }, 400, corsHeaders);
  }

  try {
    const supabase = makeSupabase(env);
    const { data: post, error: fetchErr } = await supabase
      .from('gh_play_post')
      .select('id, title, author_id, comment_count')
      .eq('id', postId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!post) return jsonResp({ error: '帖子不存在' }, 404, corsHeaders);

    // 每一步都检查 error：旧实现整段忽略，删不掉也返回 success
    const { error: likeErr } = await supabase.from('gh_play_like').delete().eq('post_id', postId);
    if (likeErr) throw likeErr;
    const { error: commentErr } = await supabase.from('gh_play_comment').delete().eq('post_id', postId);
    if (commentErr) throw commentErr;
    const { error: postErr } = await supabase.from('gh_play_post').delete().eq('id', postId);
    if (postErr) throw postErr;

    return jsonResp({
      success: true,
      deleted: { id: postId, title: post.title, comments: post.comment_count || 0 },
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-play-delete-post] failed:', postId, err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}

export async function handleAdminDeletePlayComment(request, env, corsHeaders, commentId) {
  const denied = await requireWriteAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  if (!commentId || !ID_RE.test(commentId)) {
    return jsonResp({ error: '无效的评论ID' }, 400, corsHeaders);
  }

  try {
    const supabase = makeSupabase(env);
    const { data: c, error: fetchErr } = await supabase
      .from('gh_play_comment')
      .select('id, post_id, content, is_ai, author_id')
      .eq('id', commentId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!c) return jsonResp({ error: '评论不存在' }, 404, corsHeaders);

    const { count: childCount, error: countErr } = await supabase
      .from('gh_play_comment')
      .select('id', { count: 'exact', head: true })
      .eq('parent_id', commentId);
    if (countErr) throw countErr;

    const { error: delErr } = await supabase.from('gh_play_comment').delete().eq('id', commentId);
    if (delErr) throw delErr;

    return jsonResp({
      success: true,
      deleted: { id: commentId, children: childCount || 0, is_ai: !!c.is_ai },
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-play-delete-comment] failed:', commentId, err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}

export async function handleAdminPlayStats(request, env, corsHeaders) {
  const denied = await requireAdmin(request, env, corsHeaders);
  if (denied) return denied;
  await checkRateLimit(request, env, 'normal');

  try {
    const supabase = makeSupabase(env);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [posts, comments, aiComments, likes, follows, postsToday, sitePosts] = await Promise.all([
      safeCount(supabase.from('gh_play_post').select('id', { count: 'exact', head: true }), 'posts'),
      safeCount(supabase.from('gh_play_comment').select('id', { count: 'exact', head: true }), 'comments'),
      safeCount(supabase.from('gh_play_comment').select('id', { count: 'exact', head: true }).eq('is_ai', true), 'ai_comments'),
      safeCount(supabase.from('gh_play_like').select('post_id', { count: 'exact', head: true }), 'likes'),
      safeCount(supabase.from('gh_play_follow').select('follower_id', { count: 'exact', head: true }), 'follows'),
      safeCount(supabase.from('gh_play_post').select('id', { count: 'exact', head: true }).gte('created_at', since), 'posts_today'),
      safeCount(supabase.from('gh_play_post').select('id', { count: 'exact', head: true }).eq('kind', 'site'), 'site_posts'),
    ]);

    return jsonResp({
      posts, comments, ai_comments: aiComments, likes, follows,
      posts_today: postsToday, site_posts: sitePosts,
      text_posts: Math.max(0, posts - sitePosts),
    }, 200, corsHeaders);
  } catch (err) {
    console.error('[admin-play-stats] failed:', err.message);
    return jsonResp({ error: err.message, ...(err.missingMigration ? { migration: 'sql/admin_perf.sql' } : {}) },
      err.status || 502, corsHeaders);
  }
}

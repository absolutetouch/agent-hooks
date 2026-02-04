export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    const path = url.pathname

    // Accept POST on / and /inbox
    if (req.method !== 'POST' || (path !== '/' && path !== '/inbox')) {
      return new Response('Not found', { status: 404 })
    }

    const auth = req.headers.get('authorization')
    if (!auth || auth !== `Bearer ${env.SHARED_SECRET}`) {
      return new Response('Unauthorized', { status: 401 })
    }

    let payload
    try {
      payload = await req.json()
    } catch {
      return new Response('Bad JSON', { status: 400 })
    }

    // Minimal validation
    if (!payload.from || !payload.type || !payload.body) {
      return new Response('Invalid payload', { status: 400 })
    }

    // Log the message (visible in wrangler tail)
    console.log(`[inbox] from=${payload.from} type=${payload.type} body=${payload.body}`)

    // Forward to local system if configured
    if (env.LOCAL_HOOK_URL) {
      try {
        const hookRes = await fetch(env.LOCAL_HOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.LOCAL_HOOK_TOKEN || ''}`
          },
          body: JSON.stringify({
            text: `[agent-hooks] Message from ${payload.from}: ${payload.body}`
          })
        })
        console.log(`[hook] forwarded to local: ${hookRes.status}`)
      } catch (err) {
        console.log(`[hook] forward failed: ${err.message}`)
      }
    }

    return new Response(JSON.stringify({ status: 'received', from: payload.from, type: payload.type }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

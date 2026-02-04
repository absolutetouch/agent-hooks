export default {
  async fetch(req, env) {
    if (req.method !== 'POST') {
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

    // Never execute tools here.
    // Just forward the message to your local system.

    await fetch(env.LOCAL_HOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.LOCAL_HOOK_TOKEN}`
      },
      body: JSON.stringify({
        kind: 'systemEvent',
        text: `Message from ${payload.from}: ${payload.body}`
      })
    })

    return new Response('ok', { status: 200 })
  }
}

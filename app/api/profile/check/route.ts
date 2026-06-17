import 'server-only'
import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { isValidHandle } from '@/lib/handle'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const raw = searchParams.get('handle')
  if (!raw) return NextResponse.json({ error: 'Missing handle' }, { status: 400 })

  const handle = raw.toLowerCase().trim()
  if (!isValidHandle(handle)) {
    return NextResponse.json({ available: false })
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('handle')
    .eq('handle', handle)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ available: data === null })
}

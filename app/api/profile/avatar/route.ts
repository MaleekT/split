import 'server-only'
import { NextResponse } from 'next/server'
import { isAddress, getAddress, verifyMessage } from 'viem'
import { supabase } from '@/lib/supabase'

const MAX_BYTES = 1_048_576 // 1 MB
const ALLOWED   = new Set(['image/jpeg', 'image/png', 'image/webp'])

export async function POST(req: Request) {
  let form: FormData
  try { form = await req.formData() }
  catch { return NextResponse.json({ error: 'Invalid form data' }, { status: 400 }) }

  const rawAddress = form.get('address')
  const signature  = form.get('signature')
  const fileEntry  = form.get('file')

  if (typeof rawAddress !== 'string' || !isAddress(rawAddress)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }
  // Exclude string and null — narrowed to File by TypeScript
  if (typeof fileEntry === 'string' || fileEntry === null) {
    return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
  }

  const address = getAddress(rawAddress)
  const message  = `Split: update avatar for ${address.toLowerCase()}`
  const valid    = await verifyMessage({
    address,
    message,
    signature: signature as `0x${string}`,
  })
  if (!valid) return NextResponse.json({ error: 'Signature invalid' }, { status: 403 })

  if (!ALLOWED.has(fileEntry.type)) {
    return NextResponse.json(
      { error: 'Unsupported type — use JPEG, PNG, or WebP' },
      { status: 400 },
    )
  }
  if (fileEntry.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File must be under 1 MB' }, { status: 400 })
  }

  // Read into buffer once — used for both magic-byte check and Supabase upload.
  // Supabase storage accepts ArrayBuffer as a documented input type.
  const buffer = await fileEntry.arrayBuffer()
  const bytes  = new Uint8Array(buffer)

  // Validate actual file content against known magic bytes.
  // Guards against MIME spoofing (e.g. an SVG uploaded with Content-Type: image/jpeg).
  const isPng  = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8
  // WebP: "RIFF" at 0-3, "WEBP" at 8-11 (file must be ≥12 bytes)
  const isWebp = bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50

  if (!isPng && !isJpeg && !isWebp) {
    return NextResponse.json(
      { error: 'File content does not match a supported image format (JPEG, PNG, or WebP)' },
      { status: 400 },
    )
  }

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(address, buffer, { contentType: fileEntry.type, upsert: true })

  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 })

  const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(address)

  const { error: dbError } = await supabase
    .from('profiles')
    .upsert({ address, avatar_url: urlData.publicUrl }, { onConflict: 'address' })

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 })

  return NextResponse.json({ avatar_url: urlData.publicUrl })
}

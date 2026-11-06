import { proxy } from '@/lib/proxy';
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };
const handler = async (req: Request, { params }: Ctx) => proxy(req, `/v1/${(await params).path.map(encodeURIComponent).join('/')}`);
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS };

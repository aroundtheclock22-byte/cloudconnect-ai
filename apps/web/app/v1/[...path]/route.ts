import { proxy } from '@/lib/proxy';
export const dynamic = 'force-dynamic';
const handler = (req: Request, { params }: { params: { path: string[] } }) => proxy(req, `/v1/${params.path.map(encodeURIComponent).join('/')}`);
export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS };

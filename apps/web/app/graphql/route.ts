import { proxy } from '@/lib/proxy';
export const dynamic = 'force-dynamic';
const handler = (req: Request) => proxy(req, '/graphql');
export { handler as GET, handler as POST };

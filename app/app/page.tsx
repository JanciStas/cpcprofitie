import { redirect } from 'next/navigation';

// /app had no page of its own and returned a 404, while the login redirect,
// bookmarks and people typing the URL all land here.
export default function AppIndex() {
  redirect('/app/overview');
}

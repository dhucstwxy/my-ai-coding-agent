export type User = { first: string; last: string; id: string };

export function formatUser(user: User): string {
  const name = `${user.last}, ${user.first}`;
  return `#${user.id} ${name}`;
}

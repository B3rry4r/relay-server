export function Card({ title }: { title: string }) {
  return (
    <section className="rounded-[12px] border border-[#e7e7e7]">
      <h3>{title}</h3>
    </section>
  );
}

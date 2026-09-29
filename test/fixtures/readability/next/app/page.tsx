import { Card } from '../components/Card';

export default function Page() {
  const items = ['a', 'b'];
  return (
    <div className="p-[13px] bg-[#f4f4f4]">
      {items.map((i) => (
        <div key={i}>
          <Card title={i} />
        </div>
      ))}
    </div>
  );
}

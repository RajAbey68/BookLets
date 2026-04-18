export default function BookingsPage() {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2.5rem' }}>
        <div>
          <div style={{ fontSize: '0.875rem', color: 'var(--accent-color)', fontWeight: '600', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Bookings
          </div>
          <h1 style={{ marginBottom: 0 }}>Reservations</h1>
        </div>
        
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', color: 'var(--text-primary)', fontWeight: '600', cursor: 'pointer' }}>
            Filter
          </button>
          <button style={{ padding: '0.75rem 1.25rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: '#fff', fontWeight: '600', cursor: 'pointer' }}>
            + Create Booking
          </button>
        </div>
      </div>

      <div className="glass-card">
        <table className="premium-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Property</th>
              <th>Guest</th>
              <th>Check In</th>
              <th>Check Out</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th style={{ textAlign: 'right' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {[
              { id: 'BK-4829', prop: 'Villa Oceanview', guest: 'Alice Smith', in: 'Oct 12', out: 'Oct 15', total: '€450.00', status: 'Active' },
              { id: 'BK-4828', prop: 'City Loft 4', guest: 'Bob Johnson', in: 'Oct 14', out: 'Oct 17', total: '€1,200.00', status: 'Upcoming' },
              { id: 'BK-4827', prop: 'The Penthouse', guest: 'Charlie Davis', in: 'Oct 05', out: 'Oct 10', total: '€3,150.00', status: 'Completed' },
              { id: 'BK-4826', prop: 'Mountain Cabin', guest: 'David Brown', in: 'Oct 01', out: 'Oct 04', total: '€400.00', status: 'Cancelled' },
            ].map((row, i) => (
              <tr key={i}>
                <td data-label="ID" style={{ fontWeight: '600', color: 'var(--accent-color)' }}>{row.id}</td>
                <td data-label="Property">{row.prop}</td>
                <td data-label="Guest" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ width: '24px', height: '24px', borderRadius: '6px', background: 'var(--surface-border)' }} className="hidden sm:block" />
                  {row.guest}
                </td>
                <td data-label="Check In">{row.in}</td>
                <td data-label="Check Out">{row.out}</td>
                <td data-label="Total" style={{ textAlign: 'right', fontWeight: '600' }}>{row.total}</td>
                <td data-label="Status" style={{ textAlign: 'right' }}>
                  <span className={`badge ${
                    row.status === 'Active' ? 'badge-success' : 
                    row.status === 'Upcoming' ? 'badge-warning' : 
                    row.status === 'Cancelled' ? 'badge-danger' : 'badge-success'
                  }`}>
                    {row.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

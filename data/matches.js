const matches = [
  {
    slug: "csk-vs-mi-chepauk",
    league: "TATA IPL 2026",
    heroLabel: "Southern derby under lights",
    homeTeam: "Chennai Super Kings",
    awayTeam: "Mumbai Indians",
    dateTime: "2026-03-28T19:30:00+05:30",
    stadium: "MA Chidambaram Stadium",
    city: "Chennai",
    summary:
      "Fast-moving inventory for Chepauk's biggest rivalry night, with family stands, club zones, and premium decks all in one flow.",
    tags: ["Instant e-ticket", "UPI + cards", "Seat class availability"],
    sections: [
      {
        id: "north-upper",
        label: "North Upper",
        stand: "Budget Fan Stand",
        rows: "Rows H-K",
        price: 1800,
        capacity: 3200,
        baseSold: 2510,
        perks: ["Best-value bowl view", "Fast gate 2 access"],
        accent: "#fbbf24",
        viewLabel: "High and loud with full-bowl sightlines"
      },
      {
        id: "east-lower",
        label: "East Lower",
        stand: "Prime Lower Tier",
        rows: "Rows C-G",
        price: 2800,
        capacity: 2400,
        baseSold: 1980,
        perks: ["Closer to boundary rope", "Food court nearby"],
        accent: "#fb7185",
        viewLabel: "Closer to field action and team dugout"
      },
      {
        id: "west-premium",
        label: "West Premium",
        stand: "Hospitality Edge",
        rows: "Rows A-C",
        price: 5200,
        capacity: 760,
        baseSold: 540,
        perks: ["Cushioned seats", "Dedicated lounge lane"],
        accent: "#38bdf8",
        viewLabel: "Low-angle premium sightline with shade"
      },
      {
        id: "south-club",
        label: "South Club",
        stand: "Club Pavilion",
        rows: "Rows B-F",
        price: 7600,
        capacity: 420,
        baseSold: 302,
        perks: ["Premium washrooms", "Priority entry"],
        accent: "#22c55e",
        viewLabel: "Balanced center-wicket view for replays and pace"
      }
    ]
  },
  {
    slug: "rcb-vs-kkr-bengaluru",
    league: "TATA IPL 2026",
    heroLabel: "High-scoring night in Bengaluru",
    homeTeam: "Royal Challengers Bengaluru",
    awayTeam: "Kolkata Knight Riders",
    dateTime: "2026-04-02T19:30:00+05:30",
    stadium: "M. Chinnaswamy Stadium",
    city: "Bengaluru",
    summary:
      "Designed for a fast marketplace-style ticket flow while staying ready for authorized inventory feeds and direct payment capture.",
    tags: ["Live sync-ready API", "Section pricing", "Razorpay checkout"],
    sections: [
      {
        id: "p1-upper",
        label: "P1 Upper",
        stand: "Crowd Favorite",
        rows: "Rows J-N",
        price: 2200,
        capacity: 3400,
        baseSold: 2820,
        perks: ["City skyline view", "Budget-friendly access"],
        accent: "#fb7185",
        viewLabel: "Big atmosphere with clear end-to-end angle"
      },
      {
        id: "p1-lower",
        label: "P1 Lower",
        stand: "Lower Bowl",
        rows: "Rows D-H",
        price: 3400,
        capacity: 2100,
        baseSold: 1722,
        perks: ["Closer boundaries", "Merch kiosk access"],
        accent: "#f97316",
        viewLabel: "Boundary-side view for fast sixes"
      },
      {
        id: "executive-box",
        label: "Executive Box",
        stand: "Indoor Lounge",
        rows: "Suites 1-8",
        price: 8800,
        capacity: 320,
        baseSold: 232,
        perks: ["Hospitality service", "Sheltered seating"],
        accent: "#38bdf8",
        viewLabel: "Premium indoor-outdoor blend for guests"
      },
      {
        id: "grand-terrace",
        label: "Grand Terrace",
        stand: "Terrace Deck",
        rows: "Rows A-C",
        price: 6500,
        capacity: 540,
        baseSold: 405,
        perks: ["Open-air lounge", "Priority food counter"],
        accent: "#f59e0b",
        viewLabel: "Wide-angle premium social viewing zone"
      }
    ]
  },
  {
    slug: "gt-vs-rr-ahmedabad",
    league: "TATA IPL 2026",
    heroLabel: "Weekend afternoon blockbuster",
    homeTeam: "Gujarat Titans",
    awayTeam: "Rajasthan Royals",
    dateTime: "2026-04-05T15:30:00+05:30",
    stadium: "Narendra Modi Stadium",
    city: "Ahmedabad",
    summary:
      "A large-capacity venue setup with multiple price ladders, ideal for showing live seat counts and section-based filtering across the purchase flow.",
    tags: ["Large inventory map", "Family stand options", "Mobile ticket delivery"],
    sections: [
      {
        id: "upper-square",
        label: "Upper Square",
        stand: "Value Ring",
        rows: "Rows K-P",
        price: 1500,
        capacity: 5200,
        baseSold: 3760,
        perks: ["Lowest starting price", "Fast digital entry"],
        accent: "#2dd4bf",
        viewLabel: "Full stadium sweep on a value ticket"
      },
      {
        id: "lower-square",
        label: "Lower Square",
        stand: "Central Lower",
        rows: "Rows D-H",
        price: 2600,
        capacity: 3100,
        baseSold: 2190,
        perks: ["Balanced sightline", "Near fan activation zone"],
        accent: "#60a5fa",
        viewLabel: "Center-wicket comfort without premium pricing"
      },
      {
        id: "premium-club",
        label: "Premium Club",
        stand: "Club Lounge",
        rows: "Rows A-D",
        price: 6100,
        capacity: 680,
        baseSold: 432,
        perks: ["Lounge entry", "Dedicated queue"],
        accent: "#f59e0b",
        viewLabel: "Comfort-first seats with premium amenities"
      },
      {
        id: "sky-box",
        label: "Sky Box",
        stand: "Private Suite",
        rows: "Boxes 1-12",
        price: 9800,
        capacity: 240,
        baseSold: 126,
        perks: ["Private service", "Covered seating"],
        accent: "#c084fc",
        viewLabel: "Top-tier hosting setup for premium buyers"
      }
    ]
  },
  {
    slug: "srh-vs-dc-hyderabad",
    league: "TATA IPL 2026",
    heroLabel: "Orange army night game",
    homeTeam: "Sunrisers Hyderabad",
    awayTeam: "Delhi Capitals",
    dateTime: "2026-04-09T19:30:00+05:30",
    stadium: "Rajiv Gandhi International Stadium",
    city: "Hyderabad",
    summary:
      "Built with multi-section inventory cards, checkout breakdowns, and a clear compliance note so the product feels polished and buyer-trustworthy.",
    tags: ["Real-time refresh", "Transparent fees", "Checkout-ready"],
    sections: [
      {
        id: "north-plaza",
        label: "North Plaza",
        stand: "Fan Stand",
        rows: "Rows G-L",
        price: 1700,
        capacity: 2800,
        baseSold: 2080,
        perks: ["High-energy section", "Quick concessions access"],
        accent: "#fb923c",
        viewLabel: "Affordable and loud with good replay screen angle"
      },
      {
        id: "east-gallery",
        label: "East Gallery",
        stand: "Mid-tier View",
        rows: "Rows C-H",
        price: 2900,
        capacity: 1960,
        baseSold: 1420,
        perks: ["Balanced view", "Family seating proximity"],
        accent: "#38bdf8",
        viewLabel: "Strong all-round visibility from square leg"
      },
      {
        id: "orange-lounge",
        label: "Orange Lounge",
        stand: "Premium Lounge",
        rows: "Rows A-C",
        price: 5400,
        capacity: 520,
        baseSold: 332,
        perks: ["Premium washrooms", "Dedicated hospitality lane"],
        accent: "#facc15",
        viewLabel: "Comfort-first lounge with sharper pitch view"
      },
      {
        id: "captains-club",
        label: "Captain's Club",
        stand: "Executive Club",
        rows: "Rows A-B",
        price: 7600,
        capacity: 260,
        baseSold: 162,
        perks: ["Hosted access", "Fast-track check-in"],
        accent: "#22c55e",
        viewLabel: "Corporate-style hospitality for premium buyers"
      }
    ]
  }
];

function getAllMatches() {
  return matches;
}

function getMatchBySlug(slug) {
  return matches.find((match) => match.slug === slug);
}

function getMatchSummary(match) {
  return {
    approxRemaining: match.sections.reduce(
      (total, section) => total + (section.capacity - section.baseSold),
      0,
    ),
    startingPrice: Math.min(...match.sections.map((section) => section.price))
  };
}

module.exports = {
  getAllMatches,
  getMatchBySlug,
  getMatchSummary
};

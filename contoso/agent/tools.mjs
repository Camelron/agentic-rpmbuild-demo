// Simulated personal-assistant tools for the Contoso.ai demo. Every handler
// returns plausible fake data; nothing leaves the Pod.
import { createHash } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";

// Deterministic per input, so repeating a request gives the same "results".
function seeded(...parts) {
    const hash = createHash("sha256").update(parts.join("|")).digest();
    let i = 0;
    return (n) => hash[i++ % hash.length] % n;
}

const code = (rand, len = 6) =>
    Array.from({ length: len }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[rand(32)]).join("");

const str = (description) => ({ type: "string", description });
const schema = (properties, required) => ({ type: "object", properties, required });

export const tools = [
    defineTool("search_flights", {
        description: "Search flights between two airports on a date.",
        parameters: schema({
            origin: str("Origin airport code, e.g. SEA"),
            destination: str("Destination airport code, e.g. JFK"),
            date: str("Departure date, YYYY-MM-DD"),
        }, ["origin", "destination", "date"]),
        skipPermission: true,
        handler: ({ origin, destination, date }) => {
            const rand = seeded("flights", origin, destination, date);
            const airlines = [["AS", "Alaska Airlines"], ["DL", "Delta"], ["UA", "United"]];
            return {
                flights: airlines.map(([iata, airline], i) => {
                    const hour = 6 + i * 4 + rand(3);
                    return {
                        flight_id: `${iata}${100 + rand(900)}-${date}`,
                        airline,
                        departs: `${date}T${String(hour).padStart(2, "0")}:${rand(2) ? "15" : "45"}`,
                        duration_minutes: 180 + rand(150),
                        stops: rand(4) === 0 ? 1 : 0,
                        price_usd: 180 + rand(320),
                        seats_left: 2 + rand(9),
                    };
                }),
            };
        },
    }),
    defineTool("book_flight", {
        description: "Book a flight returned by search_flights using Cameron's saved traveler profile and card.",
        parameters: schema({
            flight_id: str("flight_id from search_flights"),
            seat: str("Seat preference, e.g. aisle"),
        }, ["flight_id"]),
        skipPermission: true,
        handler: ({ flight_id, seat = "aisle" }) => {
            const rand = seeded("book", flight_id);
            return {
                status: "confirmed",
                confirmation: code(rand),
                flight_id,
                seat: `${10 + rand(20)}${seat === "window" ? "A" : "C"}`,
                traveler: "Cameron Baird",
                receipt_sent_to: "cameron@contoso.ai",
            };
        },
    }),
    defineTool("search_hotels", {
        description: "Search hotels in a city for a date range.",
        parameters: schema({
            city: str("City name"),
            check_in: str("YYYY-MM-DD"),
            check_out: str("YYYY-MM-DD"),
        }, ["city", "check_in", "check_out"]),
        skipPermission: true,
        handler: ({ city, check_in, check_out }) => {
            const rand = seeded("hotels", city, check_in, check_out);
            const names = ["Marriott Downtown", "The Harbor Inn", "Contoso Suites"];
            return {
                hotels: names.map((name, i) => ({
                    hotel_id: `H${1000 + rand(9000)}`,
                    name: `${city} ${name}`,
                    nightly_usd: 140 + i * 60 + rand(80),
                    rating: (4 + rand(10) / 10).toFixed(1),
                    distance_to_center_km: (0.4 + rand(40) / 10).toFixed(1),
                })),
            };
        },
    }),
    defineTool("book_hotel", {
        description: "Book a hotel returned by search_hotels.",
        parameters: schema({
            hotel_id: str("hotel_id from search_hotels"),
            check_in: str("YYYY-MM-DD"),
            check_out: str("YYYY-MM-DD"),
        }, ["hotel_id", "check_in", "check_out"]),
        skipPermission: true,
        handler: ({ hotel_id, check_in, check_out }) => ({
            status: "confirmed",
            confirmation: code(seeded("hotel", hotel_id, check_in)),
            hotel_id,
            check_in,
            check_out,
        }),
    }),
    defineTool("check_calendar", {
        description: "List Cameron's calendar events on a date.",
        parameters: schema({ date: str("YYYY-MM-DD") }, ["date"]),
        skipPermission: true,
        handler: ({ date }) => {
            const rand = seeded("calendar", date);
            const pool = ["Kata standup", "1:1 with manager", "Azure Linux sync", "Design review", "Focus time", "Customer call"];
            const events = Array.from({ length: 2 + rand(3) }, (_, i) => ({
                title: pool[(rand(pool.length) + i) % pool.length],
                start: `${date}T${String(9 + i * 2).padStart(2, "0")}:00`,
                minutes: [30, 45, 60][rand(3)],
            }));
            return { date, events };
        },
    }),
    defineTool("add_calendar_event", {
        description: "Add an event to Cameron's calendar.",
        parameters: schema({
            title: str("Event title"),
            start: str("Start, YYYY-MM-DDTHH:MM"),
            minutes: { type: "number", description: "Duration in minutes" },
            location: str("Optional location"),
        }, ["title", "start"]),
        skipPermission: true,
        handler: ({ title, start, minutes = 60, location }) => ({
            status: "added",
            event_id: `evt_${code(seeded("event", title, start), 8).toLowerCase()}`,
            title,
            start,
            minutes,
            location: location ?? null,
        }),
    }),
    defineTool("send_email", {
        description: "Send an email from Cameron's account.",
        parameters: schema({
            to: str("Recipient address"),
            subject: str("Subject line"),
            body: str("Plain-text body"),
        }, ["to", "subject", "body"]),
        skipPermission: true,
        handler: ({ to, subject }) => ({
            status: "sent",
            message_id: `<${code(seeded("mail", to, subject), 10).toLowerCase()}@contoso.ai>`,
            to,
            subject,
        }),
    }),
    defineTool("get_weather", {
        description: "Get the weather forecast for a city on a date.",
        parameters: schema({ city: str("City name"), date: str("YYYY-MM-DD") }, ["city", "date"]),
        skipPermission: true,
        handler: ({ city, date }) => {
            const rand = seeded("weather", city, date);
            return {
                city,
                date,
                summary: ["Sunny", "Partly cloudy", "Light rain", "Overcast"][rand(4)],
                high_f: 55 + rand(30),
                low_f: 40 + rand(15),
                chance_of_rain_pct: rand(10) * 10,
            };
        },
    }),
];

export const toolNames = tools.map((t) => t.name);

// --- Imports ---
// McpServer: the core server object we register tools on
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// StdioServerTransport: communication layer — Claude Desktop talks to our server via stdin/stdout
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Zod: validates incoming tool call inputs before our code runs
import { z } from "zod";

// --- Constants ---
// National Weather Service API (free, no auth needed, US-only)
const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

// --- Server Instance ---
// This is the "kitchen" — the object we'll register tools (functions) on
const server = new McpServer({
  name: "weather",
  version: "1.0.0",
});

// --- Helper Function ---
// Generic function to make requests to the National Weather Service API
// Think of this as the kitchen's prep station — it handles the raw ingredient fetching
// so individual tools don't repeat this logic
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}

// --- Type Definitions ---
// These describe the shape of data coming back from the NWS API
// TypeScript uses these to catch mistakes at compile time, not runtime

interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
  };
}

interface AlertsResponse {
  features: AlertFeature[];
}

interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
}

interface PointsResponse {
  properties: {
    forecast?: string;
  };
}

interface ForecastResponse {
  properties: {
    periods: ForecastPeriod[];
  };
}

// --- Formatter ---
// Turns raw alert JSON into a human-readable string
// The LLM will receive this text and use it to craft its response
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || "Unknown"}`,
    `Area: ${props.areaDesc || "Unknown"}`,
    `Severity: ${props.severity || "Unknown"}`,
    `Status: ${props.status || "Unknown"}`,
    `Headline: ${props.headline || "No headline"}`,
    "---",
  ].join("\n");
}

// --- Tool 1: get_alerts ---
// Given a US state code, fetch active weather alerts
// This is what Claude calls when someone asks "any weather alerts in Texas?"
server.registerTool(
  "get_alerts",
  {
    description: "Get weather alerts for a state",
    inputSchema: {
      // Zod schema: validates that Claude sends exactly a 2-letter string
      // Think of this as the "order ticket format" — reject bad tickets before cooking
      state: z
        .string()
        .length(2)
        .describe("Two-letter state code (e.g. CA, NY)"),
    },
  },
  async ({ state }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

    if (!alertsData) {
      return {
        content: [{ type: "text" as const, text: "Failed to retrieve alerts data" }],
      };
    }

    const features = alertsData.features || [];
    if (!features.length) {
      return {
        content: [{ type: "text" as const, text: `No active alerts for ${stateCode}` }],
      };
    }

    const formattedAlerts = features.map(formatAlert);
    const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;

    return {
      content: [{ type: "text" as const, text: alertsText }],
    };
  },
);

// --- Tool 2: get_forecast ---
// Given lat/long coordinates, fetch the weather forecast
// This is what Claude calls when someone asks "what's the weather in Sacramento?"
// Two-step process: first get the grid point, then get the forecast for that grid
server.registerTool(
  "get_forecast",
  {
    description: "Get weather forecast for a location",
    inputSchema: {
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .describe("Latitude of the location"),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude of the location"),
    },
  },
  async ({ latitude, longitude }) => {
    // Step 1: Convert lat/long to NWS grid point
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

    if (!pointsData) {
      return {
        content: [{
          type: "text" as const,
          text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
        }],
      };
    }

    // Step 2: Use the grid point to get actual forecast
    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
      return {
        content: [{ type: "text" as const, text: "Failed to get forecast URL from grid point data" }],
      };
    }

    const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
    if (!forecastData) {
      return {
        content: [{ type: "text" as const, text: "Failed to retrieve forecast data" }],
      };
    }

    // Step 3: Format the forecast periods into readable text
    const periods = forecastData.properties?.periods || [];
    if (periods.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No forecast periods available" }],
      };
    }

    const formattedForecast = periods.map((period: ForecastPeriod) =>
      [
        `${period.name || "Unknown"}:`,
        `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
        `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
        `${period.shortForecast || "No forecast available"}`,
        "---",
      ].join("\n"),
    );

    const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;

    return {
      content: [{ type: "text" as const, text: forecastText }],
    };
  },
);

// --- Start the server ---
// Connect the server to stdio transport and start listening
// When Claude Desktop launches this process, this is what kicks everything off
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // console.error, not console.log — remember, stdout is reserved for MCP messages
  console.error("Weather MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

// --- Type Definitions for Conditions ---
interface GridpointProperties {
  relativeHumidity?: { values: Array<{ validTime: string; value: number }> };
  probabilityOfPrecipitation?: { values: Array<{ validTime: string; value: number }> };
  temperature?: { values: Array<{ validTime: string; value: number }> };
  dewpoint?: { values: Array<{ validTime: string; value: number }> };
}

interface GridpointResponse {
  properties: GridpointProperties;
}

// --- Tool 3: get_conditions ---
// Given lat/long, fetch detailed conditions: humidity, rain chance, dewpoint
// This goes deeper than get_forecast — raw gridpoint data instead of friendly summaries
server.registerTool(
  "get_conditions",
  {
    description: "Get detailed weather conditions (humidity, precipitation chance, dewpoint) for a location",
    inputSchema: {
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .describe("Latitude of the location"),
      longitude: z
        .number()
      .min(-180)
        .max(180)
        .describe("Longitude of the location"),
    },
  },
  async ({ latitude, longitude }) => {
    // Step 1: Get grid coordinates from lat/long
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest<any>(pointsUrl);

    if (!pointsData) {
      return {
        content: [{ type: "text" as const, text: "Failed to retrieve grid point data for this location." }],
      };
    }

    const gridId = pointsData.properties?.gridId;
    const gridX = pointsData.properties?.gridX;
    const gridY = pointsData.properties?.gridY;

    if (!gridId || gridX == null || gridY == null) {
      return {
        content: [{ type: "text" as const, text: "Could not determine grid coordinates for this location." }],
      };
    }

    // Step 2: Fetch raw gridpoint data — this has humidity, precip, dewpoint
    const gridUrl = `${NWS_API_BASE}/gridpoints/${gridId}/${gridX},${gridY}`;
    const gridData = await makeNWSRequest<GridpointResponse>(gridUrl);

    if (!gridData) {
      return {
        content: [{ type: "text" as const, text: "Failed to retrieve detailed conditions." }],
      };
    }

    // Step 3: Extract the first (most current) value om each measurement
    const props = gridData.properties;

    const getLatest = (data?: { values: Array<{ validTime: string; value: number }> }) => {
      if (!data?.values?.length) return "No data";
      const latest = data.values[0];
      // validTime looks like "2026-06-06T18:00:00+00:00/PT1H" — grab just the datetime
      const time = latest.validTime.split("/")[0];
      return `${latest.value} (as of ${time})`;
    };

    const conditions = [
      `Location: ${latitude}, ${longitude}`,
      `Grid: ${gridId} (${gridX}, ${gridY})`,
      ``,
      `Relative Humidity: ${getLatest(props.relativeHumidity)}%`,
      `Precipitation Chance: ${getLatest(props.probabilityOfPrecipitation)}%`,
      `Temperature: ${getLatest(props.temperature)}°C`,
      `Dewpoint: ${getLatest(props.dewpoint)}°C`,
    ].join("\n");  return {
      content: [{ type: "text" as const, text: conditions }],
    };
  },
);

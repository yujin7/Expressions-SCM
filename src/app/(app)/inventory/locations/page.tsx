import { Suspense } from "react";
import LocationsClient from "./locations-client";

export default function InventoryLocationsPage() {
  return <Suspense><LocationsClient /></Suspense>;
}

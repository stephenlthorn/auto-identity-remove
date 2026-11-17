'use strict';

/**
 * test/helpers/ca-registry-fixture.js
 *
 * A fixture in the shape of the California Privacy Protection Agency's current
 * registry.csv: a UTF-8 byte-order mark, the REAL 78 header cells (trailing
 * colons, bracketed notes, curly apostrophes, non-breaking hyphens), and
 * MADE-UP broker rows. Only the first twelve columns carry data the code reads;
 * the rest are padded empty, the way a short row would be in the real file.
 */

const CA_HEADERS = [
  "Broker ID",
  "Data broker name:",
  "Doing Business As (DBA), if applicable:",
  "Data broker primary website:",
  "Data broker primary contact email address:",
  "Data broker primary phone number: [optional]",
  "Data broker primary street address:",
  "Data broker city:",
  "Data broker state:",
  "Data broker zip code:",
  "Data broker country:",
  "Data broker's primary website that contains details on how consumers can exercise their CA Consumer Privacy rights:",
  "Data broker collects personal information of minors:",
  "Data broker collects consumers\u2019 account logins or numbers with security codes that grant access to third\u2011party accounts",
  "Data broker collects consumers\u2019 government\u2011issued identification numbers used to verify an individual\u2019s identity",
  "Data broker collects consumers' citizenship data, including immigration status",
  "Data broker collects consumers' union membership status",
  "Data broker collects consumers' sexual orientation status",
  "Data broker collects consumers' gender identity and gender expression data",
  "Data broker collects consumers' biometric data",
  "Data broker collects consumers' precise geolocation",
  "Data broker collects consumers\u2019 reproductive health care data:",
  "Data broker shared or sold consumers' data to a foreign actor in the past year",
  "Data broker shared or sold consumers' data to the federal government in the past year",
  "Data broker shared or sold consumers' data to other state governments in the past year",
  "Data broker shared or sold consumers\u2019 data to law enforcement in the past year, except when required by subpoena or court order",
  "Data broker shared or sold consumers\u2019 data to a developer of a GenAI system or model in the past year",
  "The data broker or any of its subsidiaries is regulated by the federal Fair Credit Reporting Act",
  "If the data broker or its subsidiaries are regulated by the FCRA, describe the types of personal information covered",
  "If the data broker or its subsidiaries are regulated by the FCRA, describe the specific products or services covered",
  "If the data broker or its subsidiaries are regulated by the FCRA, describe the percentage of data activities covered",
  "The data broker or any of its subsidiaries is regulated by the Gramm\u2011Leach\u2011Bliley Act (GLBA) and implementing regulations",
  "If the data broker or its subsidiaries are regulated by the GLBA, describe the types of personal information covered",
  "If the data broker or its subsidiaries are regulated by the GLBA, describe the specific products or services covered",
  "If the data broker or its subsidiaries are regulated by the GLBA, describe the percentage of data activities covered",
  "The data broker or any of its subsidiaries is regulated by the California Insurance Information and Privacy Protection Act (IIPPA)",
  "If the data broker or its subsidiaries are regulated by the IIPPA, describe the types of personal information covered",
  "If the data broker or its subsidiaries are regulated by the IIPPA, describe the specific products or services covered",
  "If the data broker or its subsidiaries are regulated by the IIPPA, describe the percentage of data activities covered",
  "The data broker or any of its subsidiaries is regulated by the California Confidentiality of Medical Information Act (CMIA)",
  "If the data broker or its subsidiaries are regulated by the CMIA, describe the types of personal information covered",
  "If the data broker or its subsidiaries are regulated by the CMIA, describe the specific products or services covered",
  "If the data broker or its subsidiaries are regulated by the CMIA, describe the percentage of data activities covered",
  "The data broker or its subsidiaries are regulated by the HIPAA privacy, security, and breach\u2011notification rules",
  "If the data broker or its subsidiaries are regulated by HIPAA, describe the types of personal information covered",
  "If the data broker or its subsidiaries are regulated by HIPAA, describe the specific products or services covered",
  "If the data broker or its subsidiaries are regulated by HIPAA, describe the percentage of data activities covered",
  "Requests to delete - Total requests received",
  "Requests to delete - Total requests received - Complied in whole",
  "Requests to delete - Total requests received - Complied in part",
  "Requests to delete - Total requests received - Denied",
  "Requests to delete - The number of days to respond substantively to a request to delete in 2024 - Mean",
  "Requests to delete - The number of days to respond substantively to a request to delete in 2024 - Median",
  "Requests to know what personal information is being collected - Total requests received",
  "Requests to know what personal information is being collected - Total requests received - Complied in whole",
  "Requests to know what personal information is being collected - Total requests received - Complied in part",
  "Requests to know what personal information is being collected - Total requests received - Denied",
  "Requests to know what personal information is being collected - The number of days to respond substantively to a request to know in 2024 - Mean",
  "Requests to know what personal information is being collected - The number of days to respond substantively to a request to know in 2024 - Median",
  "Requests to know what personal information is sold or shared - Total requests received",
  "Requests to know what personal information is sold or shared - Total requests received - Complied in whole",
  "Requests to know what personal information is sold or shared - Total requests received - Complied in part",
  "Requests to know what personal information is sold or shared - Total requests received - Denied",
  "Requests to know what personal information is sold or shared - The number of days to respond substantively to a request to know what personal information is sold or shared in 2024 - Mean",
  "Requests to know what personal information is sold or shared - The number of days to respond substantively to a request to know what personal information is sold or shared in 2024 - Median",
  "Requests to opt out of sale or sharing - Total requests received",
  "Requests to opt out of sale or sharing - Total requests received - Complied in whole",
  "Requests to opt out of sale or sharing - Total requests received - Complied in part",
  "Requests to opt out of sale or sharing - Total requests received - Denied",
  "Requests to opt out of sale or sharing - The number of days to respond substantively to a request to know in 2024 - Mean",
  "Requests to opt out of sale or sharing - The number of days to respond substantively to a request to know in 2024 - Median",
  "Requests to limit the use and disclosure of sensitive personal information - Total requests received",
  "Requests to limit the use and disclosure of sensitive personal information - Total requests received - Complied in whole",
  "Requests to limit the use and disclosure of sensitive personal information - Total requests received - Complied in part",
  "Requests to limit the use and disclosure of sensitive personal information - Total requests received - Denied",
  "Requests to limit the use and disclosure of sensitive personal information - The number of days to respond substantively to a request to know in 2024 - Mean",
  "Requests to limit the use and disclosure of sensitive personal information - The number of days to respond substantively to a request to know in 2024 - Median",
  "Additional Context or Comments:  [optional]",
];

function csvCell(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// row: [id, name, dba, website, email, phone, street, city, state, zip, country, rightsUrl]
function caCsv(rows) {
  const lines = [CA_HEADERS.map(csvCell).join(',')];
  for (const cells of rows) {
    const padded = cells.concat(new Array(Math.max(0, CA_HEADERS.length - cells.length)).fill(''));
    lines.push(padded.map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const CA_ROWS = [
  // consumer-rights URL present and different from the primary website
  ['1000', 'Acme Data Co', '', 'www.acme-data.example', 'privacy@acme-data.example', '5550100', '1 Sample St', 'Sampletown', 'CA', '90000', 'UNITED STATES', 'https://rights.acme-data.example/opt-out'],
  // embedded newline in the street address, rights URL empty: falls back to the website
  ['1001', 'Other Brokers, Inc.', '', 'other.example', 'hello@other.example', '5550101', '2 Sample Ave\nSuite 9', 'Sampletown', 'California', '90001', 'UNITED STATES', ''],
  // rights cell is not a URL: falls back to the website
  ['1002', 'Third Party LLC', '', 'https://third.example/', 'x@third.example', '5550102', '3 Sample Rd', 'Sampletown', 'Texas', '90002', 'UNITED STATES', 'see our website'],
];

module.exports = { CA_HEADERS, caCsv, CA_ROWS };
